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
from app.services.loot_box_service import loot_box_service
from app.db.repositories.item_repository import item_repository, loot_box_repository
from app.services.xp_service import xp_service

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

    # ==================== Public User Profile ====================
    @router.get("/profile/{username}")
    async def get_public_profile(username: str):
        """Public profile: basic stats for a user (no auth required)."""
        async for session in get_session():
            user = await user_repository.get_user(session, username)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        # Minimal public fields – exclude sensitive info
        return {
            "username": user.username,
            "level": getattr(user, 'user_level', 1),
            "pixels": user.total_pixels_placed,
            "messages": user.total_messages_sent,
            "achievements": len(getattr(user, 'achievements', []) or []),
            "coins": getattr(user, 'coins', 0),
            "created_at": user.created_at,
            "last_login": user.last_login,
        }

    @router.get("/pixel_bag/sync")
    async def sync_pixel_bag(current_user: AuthenticatedUser = Depends(get_current_user)):
        """Force a server-side refill tick then return authoritative pixel bag state and timing info.

        Use on reconnect or if client detects desync (negative, > max, stalled refill timer).
        """
        from datetime import datetime
        # Perform refill calculation first
        auth_service.refill_user_pixels(current_user.username)
        user = auth_service.get_user_by_username(current_user.username)
        if not getattr(user, 'last_bag_refill_at', None):
            user.last_bag_refill_at = datetime.now()
        seconds_since_anchor = (datetime.now() - user.last_bag_refill_at).total_seconds()
        if user.pixel_bag_size >= user.max_pixel_bag_size:
            next_pixel_in = 0
            full_refill_eta = 0
        else:
            remainder = settings.PIXEL_REFILL_RATE - (seconds_since_anchor % settings.PIXEL_REFILL_RATE)
            next_pixel_in = int(remainder) if remainder < settings.PIXEL_REFILL_RATE else settings.PIXEL_REFILL_RATE
            pixels_missing = user.max_pixel_bag_size - user.pixel_bag_size
            full_refill_eta = pixels_missing * settings.PIXEL_REFILL_RATE
        return {
            "pixel_bag_size": user.pixel_bag_size,
            "max_pixel_bag_size": user.max_pixel_bag_size,
            "next_pixel_in": next_pixel_in,
            "full_refill_eta": full_refill_eta
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

    # ==================== Items & Loot Boxes ====================
    @router.get('/items')
    async def list_items():
        return {"items": loot_box_service.list_items()}

    @router.get('/loot/boxes')
    async def list_loot_boxes():
        return {"boxes": loot_box_service.list_boxes()}

    @router.get('/inventory/colors')
    async def get_owned_colors(current_user: AuthenticatedUser = Depends(get_current_user)):
        user = auth_service.get_user_by_username(current_user.username)
        # Always expose 16 basic palette colors first (fixed list)
        base_palette = [
            ("basic_1", "Basic Red", "#FF0000"), ("basic_2", "Basic Green", "#00FF00"),
            ("basic_3", "Basic Blue", "#0000FF"), ("basic_4", "Basic Yellow", "#FFFF00"),
            ("basic_5", "Basic Magenta", "#FF00FF"), ("basic_6", "Basic Cyan", "#00FFFF"),
            ("basic_7", "Basic White", "#FFFFFF"), ("basic_8", "Basic Black", "#000000"),
            ("basic_9", "Basic Maroon", "#800000"), ("basic_10", "Basic DarkGreen", "#008000"),
            ("basic_11", "Basic Navy", "#000080"), ("basic_12", "Basic Olive", "#808000"),
            ("basic_13", "Basic Purple", "#800080"), ("basic_14", "Basic Teal", "#008080"),
            ("basic_15", "Basic Silver", "#C0C0C0"), ("basic_16", "Basic Gray", "#808080")
        ]
        colors = [
            {"id": bid, "name": name, "color": hexv, "rarity": "COMMON", "effect": None, "tags": ["base"]}
            for (bid, name, hexv) in base_palette
        ]
        # Append owned unlockable colors (avoid duplicates by color code & id uniqueness)
        from app.models.items import ItemType
        seen_ids = {c[0] for c in base_palette}
        for cid in getattr(user, 'owned_colors', []) or []:
            if cid in seen_ids:
                continue
            it = loot_box_service.get_item(cid)
            if it and it.type == ItemType.COLOR:
                colors.append({
                    "id": it.id,
                    "name": it.name,
                    "color": it.payload.get("color"),
                    "rarity": it.rarity,
                    "effect": it.payload.get("effect"),
                    "tags": it.tags or []
                })
        return {"colors": colors}

    # Reward scaling snapshot (diminishing returns) for UI indicator
    @router.get('/reward/scale')
    async def get_reward_scale(current_user: AuthenticatedUser = Depends(get_current_user)):
        return auth_service.get_reward_scaling_snapshot(current_user.username)

    # Rarity tier configuration
    @router.get('/tiers')
    async def get_tiers():
        from app.services import tier_service
        tiers = await tier_service.get_tiers()
        return {"tiers": tiers}

    @router.post('/admin/tiers')
    async def save_tiers(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail='Admin only')
        tiers = payload.get('tiers')
        if not isinstance(tiers, list):
            raise HTTPException(status_code=400, detail='tiers list required')
        from app.services import tier_service
        try:
            saved = await tier_service.save_tiers(tiers)
            return {"success": True, "tiers": saved}
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post('/admin/tiers/rename')
    async def rename_tier(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail='Admin only')
        old = str(payload.get('old','')).strip().lower()
        new = str(payload.get('new','')).strip().lower()
        if not old or not new:
            raise HTTPException(status_code=400, detail='old/new required')
        if old == new:
            return {"success": True, "changed": 0}
        from app.db.database import get_session
        from app.db.repositories.item_repository import item_repository, loot_box_repository
        from app.services import tier_service
        changed = 0
        async for session in get_session():
            # Update items
            items = await item_repository.list_items(session)
            for it in items:
                if it['rarity'].lower() == old:
                    await item_repository.upsert_item(session, {**it, 'rarity': new})
                    changed += 1
            # Update boxes rarity_bonus keys if present
            boxes = await loot_box_repository.list_boxes(session)
            for bx in boxes:
                bonus = bx.get('rarity_bonus') or {}
                if old in bonus:
                    bonus[new] = bonus.pop(old)
                    await loot_box_repository.upsert_box(session, {
                        'id': bx['id'], 'name': bx['name'], 'price_coins': bx['price_coins'],
                        'drops': bx['drops'], 'guaranteed': bx['guaranteed'], 'rarity_bonus': bonus,
                        'max_rolls': bx.get('max_rolls',1)
                    })
            await session.commit()
            # Refresh tiers (rename in tiers list)
            tiers = await tier_service.get_tiers(session, force_refresh=True)
            modified = False
            for t in tiers:
                if t['key'] == old:
                    t['key'] = new
                    modified = True
            if modified:
                await tier_service.save_tiers(tiers, session)
            break
        return {"success": True, "changed": changed}

    # ----- Admin Loot Management -----
    @router.post("/loot/admin/item/upsert")
    async def admin_upsert_item(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail="Admin only")
        required = {"id","type","name","rarity"}
        if not required.issubset(payload):
            raise HTTPException(status_code=400, detail="Missing fields")
        from app.models.items import ItemDef, parse_item_type, parse_rarity
        try:
            item = ItemDef(
                id=payload['id'],
                type=parse_item_type(payload['type']),
                name=payload['name'],
                rarity=parse_rarity(payload['rarity']),
                payload=payload.get('payload', {}),
                tags=payload.get('tags', [])
            )
            loot_box_service.items[item.id] = item
            # Persist to DB
            async for session in get_session():
                await item_repository.upsert_item(session, {
                    'id': item.id,
                    'type': item.type.value,
                    'name': item.name,
                    'rarity': item.rarity.value,
                    'payload': item.payload,
                    'tags': item.tags
                })
                await session.commit()
            return {"success": True, "item": item.id}
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid item: {e}")

    @router.delete("/loot/admin/item/{item_id}")
    async def admin_delete_item(item_id: str, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail="Admin only")
        if item_id in loot_box_service.items:
            del loot_box_service.items[item_id]
            async for session in get_session():
                await item_repository.delete_item(session, item_id)
                await session.commit()
            return {"success": True}
        raise HTTPException(status_code=404, detail="Item not found")

    @router.post("/loot/admin/box/upsert")
    async def admin_upsert_box(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail="Admin only")
        required = {"id","name","price_coins","drops"}
        if not required.issubset(payload):
            raise HTTPException(status_code=400, detail="Missing fields")
        from app.models.items import LootBoxDef, LootBoxDrop
        try:
            drops = [LootBoxDrop(item_id=d['item_id'], weight=int(d['weight'])) for d in payload['drops']]
            box = LootBoxDef(
                id=payload['id'],
                name=payload['name'],
                price_coins=int(payload['price_coins']),
                drops=drops,
                guaranteed=payload.get('guaranteed', []),
                rarity_bonus=payload.get('rarity_bonus', {}),
                max_rolls=int(payload.get('max_rolls', 1))
            )
            loot_box_service.boxes[box.id] = box
            async for session in get_session():
                await loot_box_repository.upsert_box(session, {
                    'id': box.id,
                    'name': box.name,
                    'price_coins': box.price_coins,
                    'drops': [d.__dict__ for d in box.drops],
                    'guaranteed': box.guaranteed,
                    'rarity_bonus': box.rarity_bonus,
                    'max_rolls': box.max_rolls
                })
                await session.commit()
            return {"success": True, "box": box.id}
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid box: {e}")

    @router.delete("/loot/admin/box/{box_id}")
    async def admin_delete_box(box_id: str, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail="Admin only")
        if box_id in loot_box_service.boxes:
            del loot_box_service.boxes[box_id]
            async for session in get_session():
                await loot_box_repository.delete_box(session, box_id)
                await session.commit()
            return {"success": True}
        raise HTTPException(status_code=404, detail="Box not found")

    @router.get("/loot/admin/export")
    async def admin_export_loot(current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail="Admin only")
        return {"items": loot_box_service.list_items(), "boxes": loot_box_service.list_boxes()}

    @router.post("/loot/admin/import")
    async def admin_import_loot(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail="Admin only")
        items = payload.get('items', [])
        boxes = payload.get('boxes', [])
        from app.models.items import ItemDef, parse_item_type, parse_rarity, LootBoxDef, LootBoxDrop
        imported_items = 0
        for raw in items:
            try:
                it = ItemDef(
                    id=raw['id'],
                    type=parse_item_type(raw['type']),
                    name=raw['name'],
                    rarity=parse_rarity(raw['rarity']),
                    payload=raw.get('payload', {}),
                    tags=raw.get('tags', [])
                )
                loot_box_service.items[it.id] = it
                imported_items += 1
            except Exception:
                continue
        imported_boxes = 0
        for raw in boxes:
            try:
                drops = [LootBoxDrop(item_id=d['item_id'], weight=int(d['weight'])) for d in raw.get('drops', [])]
                box = LootBoxDef(
                    id=raw['id'],
                    name=raw['name'],
                    price_coins=int(raw['price_coins']),
                    drops=drops,
                    guaranteed=raw.get('guaranteed', []),
                    rarity_bonus=raw.get('rarity_bonus', {}),
                    max_rolls=int(raw.get('max_rolls', 1))
                )
                loot_box_service.boxes[box.id] = box
                imported_boxes += 1
            except Exception:
                continue
        # Persist imported into DB
        async for session in get_session():
            for it in loot_box_service.items.values():
                await item_repository.upsert_item(session, {
                    'id': it.id,
                    'type': it.type.value,
                    'name': it.name,
                    'rarity': it.rarity.value,
                    'payload': it.payload,
                    'tags': it.tags
                })
            for bx in loot_box_service.boxes.values():
                await loot_box_repository.upsert_box(session, {
                    'id': bx.id,
                    'name': bx.name,
                    'price_coins': bx.price_coins,
                    'drops': [d.__dict__ for d in bx.drops],
                    'guaranteed': bx.guaranteed,
                    'rarity_bonus': bx.rarity_bonus,
                    'max_rolls': bx.max_rolls
                })
            await session.commit()
        return {"success": True, "imported_items": imported_items, "imported_boxes": imported_boxes}
    @router.post('/loot/open')
    async def open_loot_box(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        box_id = payload.get('box_id')
        if not box_id:
            raise HTTPException(status_code=400, detail='Missing box_id')
        result = loot_box_service.open_box(current_user.username, box_id)
        if not result.get('success'):
            raise HTTPException(status_code=400, detail=result.get('error', 'Open failed'))
        # XP reward (small) per open
        xp_service.add_xp(current_user.username, 10)
        # Reload user to get fresh XP/level/coins (open_box already persisted)
        refreshed = auth_service.get_user_by_username(current_user.username)
        if refreshed:
            result.update({
                "experience_points": getattr(refreshed, 'experience_points', 0),
                "user_level": getattr(refreshed, 'user_level', 1),
                "xp_to_next": getattr(refreshed, 'xp_to_next_cache', 0),
                "coins": getattr(refreshed, 'coins', result.get('coins', 0))
            })
        return result

    @router.post('/admin/items/upsert')
    async def admin_upsert_item(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail='Admin only')
        required = {'id','type','name','rarity'}
        if not required.issubset(payload):
            raise HTTPException(status_code=400, detail='Missing fields')
        from app.models.items import ItemDef, parse_item_type, parse_rarity
        try:
            item = ItemDef(
                id=payload['id'],
                type=parse_item_type(payload['type']),
                name=payload['name'],
                rarity=parse_rarity(payload['rarity']),
                payload=payload.get('payload', {}),
                tags=payload.get('tags', [])
            )
            loot_box_service.items[item.id] = item
            loot_box_service._save_all()
            return {"success": True, "item": item.__dict__}
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post('/admin/loot/boxes/upsert')
    async def admin_upsert_box(payload: dict, current_user: AuthenticatedUser = Depends(get_current_user)):
        if not current_user.is_admin():
            raise HTTPException(status_code=403, detail='Admin only')
        from app.models.items import LootBoxDef, LootBoxDrop
        try:
            drops = [LootBoxDrop(**d) for d in payload.get('drops', [])]
            box = LootBoxDef(
                id=payload['id'],
                name=payload.get('name', payload['id']),
                price_coins=payload.get('price_coins', 0),
                drops=drops,
                guaranteed=payload.get('guaranteed', []),
                rarity_bonus=payload.get('rarity_bonus', {}),
                max_rolls=payload.get('max_rolls', 1)
            )
            loot_box_service.boxes[box.id] = box
            loot_box_service._save_all()
            return {"success": True, "box": box.id}
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
    
    return router