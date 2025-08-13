"""
Canvas service for managing pixel operations.
"""
import time
from typing import Dict, Tuple, Optional
from app.models import Pixel
from app.core.config import settings

class CanvasService:
    """Service for managing canvas operations"""
    
    def __init__(self):
        # Canvas data organized by regions for optimization
        self.regions: Dict[Tuple[int, int], Dict[Tuple[int, int], Pixel]] = {}
        self.initialize_regions()
    
    def initialize_regions(self):
        """Initialize empty regions"""
        for region_x in range(settings.REGIONS_PER_SIDE):
            for region_y in range(settings.REGIONS_PER_SIDE):
                self.regions[(region_x, region_y)] = {}
    
    def get_region_coords(self, x: int, y: int) -> Tuple[int, int]:
        """Get region coordinates from pixel coordinates"""
        return (x // settings.REGION_SIZE, y // settings.REGION_SIZE)
    
    def get_local_coords(self, x: int, y: int) -> Tuple[int, int]:
        """Get local coordinates within a region"""
        return (x % settings.REGION_SIZE, y % settings.REGION_SIZE)
    
    def place_pixel(self, x: int, y: int, color: str, user_id: str) -> bool:
        """Place a pixel on the canvas"""
        if not self.is_valid_position(x, y):
            return False
        
        region_coords = self.get_region_coords(x, y)
        local_coords = self.get_local_coords(x, y)
        
        pixel = Pixel(x, y, color, time.time(), user_id)
        self.regions[region_coords][local_coords] = pixel
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
