"""
HTTP API endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.core.config import settings
from app.services import RegionManager
from app.services.auth_service import auth_service
from app.db.database import get_session, redis_client
from app.db.repositories.user_repository import user_repository
from sqlalchemy import select, desc
from app.services.achievement_service import achievement_service
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

    # ==================== Achievements ====================
    @router.get("/achievements/config")
    async def get_achievements_config():
        """Public: list achievement definitions (no unlock data)."""
        return {"achievements": achievement_service.get_definitions(), "version_ts": achievement_service.last_loaded_ts}

    @router.get("/achievements")
    async def get_my_achievements(current_user: AuthenticatedUser = Depends(get_current_user)):
        return {"achievements": auth_service.get_user_achievements(current_user.username)}

    @router.post("/achievements/sync")
    async def sync_achievements(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        # payload: { achievements: [ids...] }
        achievements = payload.get("achievements", [])
        if not isinstance(achievements, list):
            raise HTTPException(status_code=400, detail="Invalid achievements list")
        # Filter only valid IDs to prevent forging
        valid = achievement_service.validate_ids(achievements)
        auth_service.set_achievements(current_user.username, valid)
        return {"success": True, "achievements": auth_service.get_user_achievements(current_user.username)}

    @router.get("/achievements/distribution")
    async def achievements_distribution(current_user: AuthenticatedUser = Depends(get_current_user)):
        # Allow all authenticated users to view global percentages
        return auth_service.get_global_achievement_distribution()

    @router.post("/achievements/evaluate")
    async def force_evaluate(current_user: AuthenticatedUser = Depends(get_current_user)):
        """Trigger server-side evaluation and return newly unlocked achievements."""
        from app.services.achievement_service import achievement_service
        newly = achievement_service.evaluate_for_user(current_user.username)
        return {"newly_unlocked": newly, "all": auth_service.get_user_achievements(current_user.username)}

    # ---- Admin Achievement Management ----
    @router.post("/achievements/admin/upsert")
    async def admin_upsert_achievement(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail="Admin only")
        ach = achievement_service.upsert(payload)
        if not ach:
            raise HTTPException(status_code=400, detail="Invalid achievement data")
        return {"success": True, "achievement": ach.__dict__}

    @router.delete("/achievements/admin/{achievement_id}")
    async def admin_delete_achievement(achievement_id: str, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail="Admin only")
        if not achievement_service.delete(achievement_id):
            raise HTTPException(status_code=404, detail="Not found")
        return {"success": True}

    @router.post("/achievements/admin/import")
    async def admin_import_achievements(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail="Admin only")
        defs = payload.get('achievements')
        replace = bool(payload.get('replace'))
        if not isinstance(defs, list):
            raise HTTPException(status_code=400, detail="Invalid achievements list")
        result = achievement_service.import_bulk(defs, replace=replace)
        return {"success": True, **result}

    # ==================== Rankings ====================
    @router.get("/rankings")
    async def get_rankings(rtype: str = "pixels", limit: int = 25, current_user: AuthenticatedUser = Depends(get_current_user)):
        valid = {"pixels", "messages", "level", "achievements"}
        if rtype not in valid:
            raise HTTPException(status_code=400, detail="Invalid ranking type")
        async for session in get_session():
            users = await user_repository.get_all_users(session)
        entries = []
        for u in users:
            if u.is_banned:
                continue
            if rtype == 'pixels':
                value = u.total_pixels_placed
            elif rtype == 'messages':
                value = u.total_messages_sent
            elif rtype == 'level':
                value = getattr(u, 'user_level', 1)
            else:
                value = len(getattr(u, 'achievements', []) or [])
            entries.append({
                'username': u.username,
                'value': value,
                'level': getattr(u, 'user_level', 1),
                'pixels': u.total_pixels_placed,
                'messages': u.total_messages_sent,
                'achievements': len(getattr(u, 'achievements', []) or [])
            })
        entries.sort(key=lambda e: e['value'], reverse=True)
        ranked = []
        last_value = None
        rank = 0
        for idx, e in enumerate(entries[:limit]):
            if e['value'] != last_value:
                rank = idx + 1
                last_value = e['value']
            e['rank'] = rank
            ranked.append(e)
        return {'type': rtype, 'results': ranked}
    
    return router