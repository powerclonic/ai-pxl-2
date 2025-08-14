"""
HTTP API endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.core.config import settings
from app.services import RegionManager
from app.services.auth_service import auth_service
from app.models.models import AuthenticatedUser

security = HTTPBearer()

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> AuthenticatedUser:
    """Get current authenticated user"""
    user = auth_service.get_current_user(credentials.credentials)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user

def create_api_router(region_manager: RegionManager) -> APIRouter:
    """Create API router with endpoints"""
    router = APIRouter(prefix="/api", tags=["api"])
    
    @router.get("/canvas/{region_x}/{region_y}")
    async def get_region_data(region_x: int, region_y: int):
        """Get pixel data for a specific region (public endpoint for reading)"""
        if not (0 <= region_x < settings.REGIONS_PER_SIDE and 
                0 <= region_y < settings.REGIONS_PER_SIDE):
            return {"error": "Invalid region coordinates"}
        
        region_data = region_manager.canvas_service.get_region_data(region_x, region_y)
        return {
            "region_x": region_x,
            "region_y": region_y,
            "pixels": region_data
        }
    
    @router.get("/config")
    async def get_config():
        """Get client configuration (public endpoint)"""
        return {
            "canvas_size": settings.CANVAS_SIZE,
            "region_size": settings.REGION_SIZE,
            "pixel_refill_rate": settings.PIXEL_REFILL_RATE,
            "max_pixel_bag": settings.MAX_PIXEL_BAG,
            "initial_pixel_bag": settings.INITIAL_PIXEL_BAG,
            "authentication_required": True,
            "max_actions_per_minute": settings.MAX_ACTIONS_PER_MINUTE,
            "captcha_required_after_failures": settings.CAPTCHA_REQUIRED_AFTER_FAILURES,
            "min_username_length": settings.MIN_USERNAME_LENGTH,
            "max_username_length": settings.MAX_USERNAME_LENGTH,
            "min_password_length": settings.MIN_PASSWORD_LENGTH
        }
    
    @router.get("/stats")
    async def get_stats(current_user: AuthenticatedUser = Depends(get_current_user)):
        """Get current statistics (requires authentication)"""
        return region_manager.get_stats()
    
    @router.get("/persistence-stats")
    async def get_persistence_stats(current_user: AuthenticatedUser = Depends(get_current_user)):
        """Get persistence system statistics (requires authentication)"""
        if not current_user.is_admin():
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin access required"
            )
        return await region_manager.canvas_service.get_persistence_stats()
    
    @router.post("/manual-save")
    async def manual_save(current_user: AuthenticatedUser = Depends(get_current_user)):
        """Trigger manual canvas save (admin only)"""
        if not current_user.is_admin():
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin access required"
            )
        
        try:
            await region_manager.canvas_service.save_snapshot()
            return {"success": True, "message": "Canvas saved successfully"}
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Save failed: {str(e)}"
            )
    
    @router.get("/health")
    async def health_check():
        """Health check endpoint (public)"""
        return {
            "status": "healthy", 
            "active_users": region_manager.user_service.get_user_count(),
            "canvas_size": f"{settings.CANVAS_SIZE}x{settings.CANVAS_SIZE}",
            "total_regions": settings.REGIONS_PER_SIDE * settings.REGIONS_PER_SIDE,
            "authentication": "enabled"
        }
    
    return router