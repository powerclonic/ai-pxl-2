"""Canvas service for managing pixel operations with Parquet persistence."""
import time
import asyncio
from typing import Dict, Tuple
from app.models import Pixel
from app.core.config import settings
from app.services.canvas_persistence import CanvasPersistence


class CanvasService:
    """Service for managing canvas operations with high-performance persistence."""

    def __init__(self):
        # Canvas data organized by regions for optimization
        self.regions: Dict[Tuple[int, int], Dict[Tuple[int, int], Pixel]] = {}
        self.persistence = CanvasPersistence()
        self._initialized = False
        self._snapshot_task = None

    async def initialize(self):
        if self._initialized:
            return
        await self.persistence.start()
        self.regions = await self.persistence.load_canvas_data()
        self._initialized = True
        print("Canvas service initialized with Parquet persistence")

        async def _snap_loop():
            while True:
                try:
                    await asyncio.sleep(settings.CANVAS_SNAPSHOT_INTERVAL_SEC)
                    await self.save_snapshot()
                    await self._enforce_retention()
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    print(f"⚠️ Snapshot loop error: {e}")

        self._snapshot_task = asyncio.create_task(_snap_loop())

    async def shutdown(self):
        if self.persistence:
            await self.persistence.save_canvas_snapshot(self.regions)
            await self.persistence.stop()
        if self._snapshot_task:
            self._snapshot_task.cancel()
            try:
                await self._snapshot_task
            except Exception:
                pass

    def initialize_regions(self):
        for region_x in range(settings.REGIONS_PER_SIDE):
            for region_y in range(settings.REGIONS_PER_SIDE):
                self.regions.setdefault((region_x, region_y), {})

    def get_region_coords(self, x: int, y: int) -> Tuple[int, int]:
        return (x // settings.REGION_SIZE, y // settings.REGION_SIZE)

    def get_local_coords(self, x: int, y: int) -> Tuple[int, int]:
        return (x % settings.REGION_SIZE, y % settings.REGION_SIZE)

    async def place_pixel(self, x: int, y: int, color: str, user_id: str, effect: str | None = None) -> bool:
        if not self.is_valid_position(x, y):
            return False
        region_coords = self.get_region_coords(x, y)
        local_coords = self.get_local_coords(x, y)
        pixel = Pixel(x, y, color, time.time(), user_id, effect)
        self.regions.setdefault(region_coords, {})[local_coords] = pixel
        if self._initialized:
            await self.persistence.save_pixel(pixel)
        return True

    def is_valid_position(self, x: int, y: int) -> bool:
        return 0 <= x < settings.CANVAS_SIZE and 0 <= y < settings.CANVAS_SIZE

    def get_region_data(self, region_x: int, region_y: int) -> Dict:
        if not self.is_valid_region(region_x, region_y):
            return {}
        if (region_x, region_y) not in self.regions:
            return {}
        region_data = {}
        for (lx, ly), pixel in self.regions[(region_x, region_y)].items():
            region_data[f"{lx},{ly}"] = {
                "color": pixel.color,
                "timestamp": pixel.timestamp,
                "user_id": pixel.user_id,
                "effect": pixel.effect,
            }
        return region_data

    def is_valid_region(self, region_x: int, region_y: int) -> bool:
        return 0 <= region_x < settings.REGIONS_PER_SIDE and 0 <= region_y < settings.REGIONS_PER_SIDE

    def get_total_pixels(self) -> int:
        return sum(len(region_pixels) for region_pixels in self.regions.values())

    async def save_snapshot(self):
        if self._initialized:
            await self.persistence.save_canvas_snapshot(self.regions)

    async def _enforce_retention(self):
        try:
            await self.persistence.enforce_retention()
        except Exception as e:
            print(f"⚠️ Retention enforcement failed: {e}")
            
    async def get_persistence_stats(self) -> Dict:
        """Get persistence statistics for monitoring"""
        if self._initialized:
            return await self.persistence.get_region_stats()
        return {}
