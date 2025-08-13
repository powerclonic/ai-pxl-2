"""
Configuration settings for the Pixel Canvas application.
"""
from typing import Dict, Any

class Settings:
    """Application settings"""
    
    # Canvas settings
    CANVAS_SIZE: int = 8192
    REGION_SIZE: int = 512
    REGIONS_PER_SIDE: int = CANVAS_SIZE // REGION_SIZE  # 16x16 grid
    
    # Pixel bag system
    PIXEL_REFILL_RATE: int = 3  # Seconds to refill one pixel
    MAX_PIXEL_BAG: int = 10  # Maximum pixels in bag
    INITIAL_PIXEL_BAG: int = 3  # Starting pixels
    
    # Chat settings
    MAX_CHAT_HISTORY_PER_REGION: int = 50
    CHAT_HISTORY_RESPONSE_LIMIT: int = 20
    
    # Server settings
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    DEBUG: bool = True
    
    # Static files
    STATIC_DIR: str = "static"
    TEMPLATES_DIR: str = "templates"

# Global settings instance
settings = Settings()
