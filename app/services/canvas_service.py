"""
Canvas service for managing pixel operations with Parquet persistence.
"""
import time
import asyncio
from typing import Dict, Tuple, Optional
from app.models import Pixel
from app.core.config import settings
from app.services.canvas_persistence import CanvasPersistence

class CanvasService:
    """Service for managing canvas operations with high-performance persistence"""
    
    def __init__(self):
        # Canvas data organized by regions for optimization
        self.regions: Dict[Tuple[int, int], Dict[Tuple[int, int], Pixel]] = {}
        self.persistence = CanvasPersistence()
        self._initialized = False
        
    async def initialize(self):
        """Initialize the canvas service and load existing data"""
        if self._initialized:
            return
            
        # Start the persistence service
        await self.persistence.start()
        
        # Load existing canvas data
        self.regions = await self.persistence.load_canvas_data()
        
        self._initialized = True
        print("Canvas service initialized with Parquet persistence")
        
    async def shutdown(self):
        """Shutdown the canvas service and save any pending data"""
        if self.persistence:
            # Save final snapshot
            await self.persistence.save_canvas_snapshot(self.regions)
            await self.persistence.stop()
            
    def initialize_regions(self):
        """Initialize empty regions (called during load)"""
        for region_x in range(settings.REGIONS_PER_SIDE):
            for region_y in range(settings.REGIONS_PER_SIDE):
                if (region_x, region_y) not in self.regions:
                    self.regions[(region_x, region_y)] = {}
    
    def get_region_coords(self, x: int, y: int) -> Tuple[int, int]:
        """Get region coordinates from pixel coordinates"""
        return (x // settings.REGION_SIZE, y // settings.REGION_SIZE)
    
    def get_local_coords(self, x: int, y: int) -> Tuple[int, int]:
        """Get local coordinates within a region"""
        return (x % settings.REGION_SIZE, y % settings.REGION_SIZE)
    
    async def place_pixel(self, x: int, y: int, color: str, user_id: str) -> bool:
        """Place a pixel on the canvas and save to persistence"""
        if not self.is_valid_position(x, y):
            return False

        region_coords = self.get_region_coords(x, y)
        local_coords = self.get_local_coords(x, y)
        
        pixel = Pixel(x, y, color, time.time(), user_id)
        self.regions[region_coords][local_coords] = pixel
        
        # Save to persistence (async batch processing)
        if self._initialized:
            await self.persistence.save_pixel(pixel)
        
        return True
    
    def is_valid_position(self, x: int, y: int) -> bool:
        """Check if position is within canvas bounds"""
        return 0 <= x < settings.CANVAS_SIZE and 0 <= y < settings.CANVAS_SIZE
    
    def get_region_data(self, region_x: int, region_y: int) -> Dict:
        """Get all pixels in a specific region"""
        if not self.is_valid_region(region_x, region_y):
            return {}
        
        if (region_x, region_y) not in self.regions:
            return {}
        
        region_data = {}
        for (local_x, local_y), pixel in self.regions[(region_x, region_y)].items():
            region_data[f"{local_x},{local_y}"] = {
                "color": pixel.color,
                "timestamp": pixel.timestamp,
                "user_id": pixel.user_id
            }
        return region_data
    
    def is_valid_region(self, region_x: int, region_y: int) -> bool:
        """Check if region coordinates are valid"""
        return (0 <= region_x < settings.REGIONS_PER_SIDE and 
                0 <= region_y < settings.REGIONS_PER_SIDE)
    
    def get_total_pixels(self) -> int:
        """Get total number of pixels placed"""
        return sum(len(region_pixels) for region_pixels in self.regions.values())
    
    async def save_snapshot(self):
        """Save a complete canvas snapshot"""
        if self._initialized:
            await self.persistence.save_canvas_snapshot(self.regions)
            
    async def get_persistence_stats(self) -> Dict:
        """Get persistence statistics for monitoring"""
        if self._initialized:
            return await self.persistence.get_region_stats()
        return {}
