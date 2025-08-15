from math import floor
from app.services.auth_service import auth_service

# Simple curve: xp for next level = base * level^1.4 + flat
BASE = 50
FLAT = 25

class XPService:
    def xp_required_for(self, level: int) -> int:
        if level <= 1:
            return BASE
        return int(BASE * (level ** 1.4) + FLAT)

    def ensure_cache(self, user):
        if not user.xp_to_next_cache:
            user.xp_to_next_cache = self.xp_required_for(user.user_level)

    def add_xp(self, username: str, amount: int) -> bool:
        user = auth_service.get_user_by_username(username)
        if not user:
            return False
        self.ensure_cache(user)
        user.experience_points += amount
        leveled = False
        level_ups = []
        while user.experience_points >= user.xp_to_next_cache:
            user.experience_points -= user.xp_to_next_cache
            user.user_level += 1
            user.xp_to_next_cache = self.xp_required_for(user.user_level)
            leveled = True
            # Level-up rewards: scaling coins
            try:
                # Simple scaling: 10 * new level coins
                delta = 10 * user.user_level
                user.coins = getattr(user, 'coins', 0) + delta
                level_ups.append({"level": user.user_level, "coin_reward": delta})
            except Exception as e:
                print(f"⚠️ Failed to grant level-up reward: {e}")
        auth_service._save_user(username)
        if leveled:
            print(f"LEVEL-UP: {username} -> {user.user_level}")
            # Broadcast level-up (best effort)
            try:
                from app.main import region_manager
                payload = {
                    "type": "level_up",
                    "user_id": username,
                    "new_level": user.user_level,
                    "levels": level_ups,
                    "coins": user.coins,
                    "experience_points": user.experience_points,
                    "xp_to_next": user.xp_to_next_cache
                }
                # Send to all regions where user is present
                user_regions = region_manager.user_regions.get(username, set()) or []
                import asyncio
                for (rx, ry) in user_regions:
                    asyncio.create_task(region_manager.broadcast_to_region(rx, ry, payload))
            except Exception as e:
                print(f"⚠️ Failed to broadcast level-up: {e}")
        return True

xp_service = XPService()
