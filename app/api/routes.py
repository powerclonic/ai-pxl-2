"""
HTTP API endpoints.
"""
from fastapi import APIRouter
from app.core.config import settings
from app.services import RegionManager

def create_api_router(region_manager: RegionManager) -> APIRouter:
    """Create API router with endpoints"""
    router = APIRouter(prefix="/api", tags=["api"])
    
    @router.get("/canvas/{region_x}/{region_y}")
    async def get_region_data(region_x: int, region_y: int):
        """Get pixel data for a specific region"""
        if not (0 <= region_x < settings.REGIONS_PER_SIDE and 
                0 <= region_y < settings.REGIONS_PER_SIDE):
            return {"error": "Invalid region coordinates"}
        
        region_data = region_manager.canvas_service.get_region_data(region_x, region_y)
        return {
            "region_x": region_x,
            "region_y": region_y,
            "pixels": region_data
        }
    
    @router.get("/stats")
    async def get_stats():
        """Get current statistics"""
        return region_manager.get_stats()
    
    @router.get("/health")
    async def health_check():
        """Health check endpoint"""
        return {
            "status": "healthy", 
            "active_users": region_manager.user_service.get_user_count(),
            "canvas_size": f"{settings.CANVAS_SIZE}x{settings.CANVAS_SIZE}",
            "total_regions": settings.REGIONS_PER_SIDE * settings.REGIONS_PER_SIDE
        }
    
    return router
