"""
Canvas persistence service using Parquet for high-performance storage.
Optimized for hundreds of thousands of concurrent connections.
"""
import os
import time
import asyncio
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from typing import Dict, List, Tuple, Optional
from datetime import datetime
from pathlib import Path
from app.models import Pixel
from app.core.config import settings

class CanvasPersistence:
    """High-performance canvas persistence using Parquet format"""
    
    def __init__(self):
        self.data_dir = Path("data")
        self.data_dir.mkdir(exist_ok=True)
        
        # Parquet files organization
        self.pixels_file = self.data_dir / "canvas_pixels.parquet"
        self.regions_dir = self.data_dir / "regions"
        self.regions_dir.mkdir(exist_ok=True)
        
        # In-memory cache for frequently accessed regions
        self.cache = {}
        self.cache_max_size = 100  # Max regions to keep in memory
        self.cache_ttl = 300  # 5 minutes TTL
        
        # Batch writing optimization
        self.pending_pixels = []
        self.batch_size = 1000
        self.last_save_time = time.time()
        self.save_interval = 30  # Save every 30 seconds
        
        # Background save task
        self._save_task = None
        self._running = True
        
    async def start(self):
        """Start the background save task"""
        self._save_task = asyncio.create_task(self._background_save_loop())
        
    async def stop(self):
        """Stop the service and save any pending data"""
        self._running = False
        if self._save_task:
            self._save_task.cancel()
            try:
                await self._save_task
            except asyncio.CancelledError:
                pass
        
        # Final save
        await self._flush_pending_pixels()
        
    async def load_canvas_data(self) -> Dict[Tuple[int, int], Dict[Tuple[int, int], Pixel]]:
        """Load all canvas data from Parquet files"""
        regions = {}
        
        # Initialize empty regions
        for region_x in range(settings.REGIONS_PER_SIDE):
            for region_y in range(settings.REGIONS_PER_SIDE):
                regions[(region_x, region_y)] = {}
        
        try:
            # Load from main canvas file if exists
            if self.pixels_file.exists():
                df = pd.read_parquet(self.pixels_file)
                print(f"Loading {len(df)} pixels from main canvas file")
                
                for _, row in df.iterrows():
                    pixel = Pixel(
                        x=int(row['x']),
                        y=int(row['y']),
                        color=str(row['color']),
                        timestamp=float(row['timestamp']),
                        user_id=str(row['user_id'])
                    )
                    
                    region_coords = self._get_region_coords(pixel.x, pixel.y)
                    local_coords = self._get_local_coords(pixel.x, pixel.y)
                    regions[region_coords][local_coords] = pixel
            
            # Load from individual region files
            for region_file in self.regions_dir.glob("region_*.parquet"):
                try:
                    df = pd.read_parquet(region_file)
                    region_x, region_y = self._parse_region_filename(region_file.name)
                    
                    for _, row in df.iterrows():
                        pixel = Pixel(
                            x=int(row['x']),
                            y=int(row['y']),
                            color=str(row['color']),
                            timestamp=float(row['timestamp']),
                            user_id=str(row['user_id'])
                        )
                        
                        local_coords = self._get_local_coords(pixel.x, pixel.y)
                        if (region_x, region_y) in regions:
                            regions[(region_x, region_y)][local_coords] = pixel
                            
                except Exception as e:
                    print(f"Error loading region file {region_file}: {e}")
            
            total_pixels = sum(len(region_pixels) for region_pixels in regions.values())
            print(f"Canvas data loaded successfully: {total_pixels} total pixels")
            
        except Exception as e:
            print(f"Error loading canvas data: {e}")
            
        return regions
        
    async def save_pixel(self, pixel: Pixel):
        """Queue a pixel for batch saving"""
        self.pending_pixels.append({
            'x': pixel.x,
            'y': pixel.y,
            'color': pixel.color,
            'timestamp': pixel.timestamp,
            'user_id': pixel.user_id,
            'region_x': pixel.x // settings.REGION_SIZE,
            'region_y': pixel.y // settings.REGION_SIZE
        })
        
        # If batch is full, save immediately
        if len(self.pending_pixels) >= self.batch_size:
            await self._flush_pending_pixels()
            
    async def save_canvas_snapshot(self, regions: Dict[Tuple[int, int], Dict[Tuple[int, int], Pixel]]):
        """Save a complete canvas snapshot"""
        try:
            all_pixels = []
            
            for region_coords, region_pixels in regions.items():
                for local_coords, pixel in region_pixels.items():
                    all_pixels.append({
                        'x': pixel.x,
                        'y': pixel.y,
                        'color': pixel.color,
                        'timestamp': pixel.timestamp,
                        'user_id': pixel.user_id,
                        'region_x': region_coords[0],
                        'region_y': region_coords[1]
                    })
            
            if all_pixels:
                df = pd.DataFrame(all_pixels)
                
                # Optimize data types for smaller file size
                df['x'] = df['x'].astype('uint16')
                df['y'] = df['y'].astype('uint16')
                df['region_x'] = df['region_x'].astype('uint8')
                df['region_y'] = df['region_y'].astype('uint8')
                df['timestamp'] = df['timestamp'].astype('float64')
                
                # Save with compression
                df.to_parquet(
                    self.pixels_file,
                    compression='snappy',
                    index=False,
                    engine='pyarrow'
                )
                
                print(f"Canvas snapshot saved: {len(all_pixels)} pixels")
                
        except Exception as e:
            print(f"Error saving canvas snapshot: {e}")
            
    async def _flush_pending_pixels(self):
        """Flush pending pixels to disk"""
        if not self.pending_pixels:
            return
            
        try:
            df = pd.DataFrame(self.pending_pixels)
            
            # Optimize data types
            df['x'] = df['x'].astype('uint16')
            df['y'] = df['y'].astype('uint16')
            df['region_x'] = df['region_x'].astype('uint8')
            df['region_y'] = df['region_y'].astype('uint8')
            df['timestamp'] = df['timestamp'].astype('float64')
            
            # Append to main file if exists, otherwise create new
            if self.pixels_file.exists():
                # Read existing data
                existing_df = pd.read_parquet(self.pixels_file)
                # Combine and remove duplicates (keep latest by timestamp)
                combined_df = pd.concat([existing_df, df], ignore_index=True)
                combined_df = combined_df.sort_values('timestamp').drop_duplicates(
                    subset=['x', 'y'], keep='last'
                )
            else:
                combined_df = df
                
            # Save with compression
            combined_df.to_parquet(
                self.pixels_file,
                compression='snappy',
                index=False,
                engine='pyarrow'
            )
            
            print(f"Flushed {len(self.pending_pixels)} pixels to disk")
            self.pending_pixels.clear()
            self.last_save_time = time.time()
            
        except Exception as e:
            print(f"Error flushing pixels: {e}")
            
    async def _background_save_loop(self):
        """Background task to periodically save pending pixels"""
        while self._running:
            try:
                await asyncio.sleep(self.save_interval)
                
                current_time = time.time()
                if (self.pending_pixels and 
                    current_time - self.last_save_time >= self.save_interval):
                    await self._flush_pending_pixels()
                    
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"Error in background save loop: {e}")
                
    def _get_region_coords(self, x: int, y: int) -> Tuple[int, int]:
        """Get region coordinates from pixel coordinates"""
        return (x // settings.REGION_SIZE, y // settings.REGION_SIZE)
        
    def _get_local_coords(self, x: int, y: int) -> Tuple[int, int]:
        """Get local coordinates within a region"""
        return (x % settings.REGION_SIZE, y % settings.REGION_SIZE)
        
    def _parse_region_filename(self, filename: str) -> Tuple[int, int]:
        """Parse region coordinates from filename like 'region_5_8.parquet'"""
        parts = filename.replace('.parquet', '').split('_')
        return int(parts[1]), int(parts[2])
        
    async def get_region_stats(self) -> Dict:
        """Get statistics about regions for monitoring"""
        stats = {
            'total_regions': settings.REGIONS_PER_SIDE * settings.REGIONS_PER_SIDE,
            'cached_regions': len(self.cache),
            'pending_pixels': len(self.pending_pixels),
            'last_save_time': self.last_save_time,
            'files': {
                'main_canvas_exists': self.pixels_file.exists(),
                'main_canvas_size': self.pixels_file.stat().st_size if self.pixels_file.exists() else 0,
                'region_files': len(list(self.regions_dir.glob("region_*.parquet")))
            }
        }
        return stats

    async def enforce_retention(self):
        """Placeholder retention: currently single snapshot file so nothing to prune."""
        return
