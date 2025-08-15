"""Achievement service: loads achievement definitions and performs server-side evaluation.

This makes the backend authoritative about which achievements exist and when they unlock,
preventing clients from forging arbitrary IDs. Evaluation currently supports simple threshold
based conditions on user statistics and session time; bulk/chat counters are passed explicitly
by callers.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, asdict
from typing import Any, Dict, List

from app.services.auth_service import auth_service
import asyncio
from app.db.database import get_session
from app.db.repositories.achievement_repository import achievement_repository


@dataclass
class AchievementDef:
    id: str
    icon: str
    name: str
    desc: str
    condition: Dict[str, Any]
    tier: str | None = None


class AchievementService:
    def __init__(self):
        self.achievements: List[AchievementDef] = []
        self.last_loaded_ts: float = 0.0
        self.load_definitions()

    def load_definitions(self) -> None:
        """Load achievements from DB only (legacy JSON removed)."""
        async def _load():
            try:
                async for session in get_session():
                    db_defs = await achievement_repository.list_definitions(session)
                    if db_defs:
                        self.achievements = [AchievementDef(**{k: d[k] for k in ['id','icon','name','desc','condition','tier']}) for d in db_defs]
                        self.last_loaded_ts = time.time()
                        print(f"Achievements: loaded {len(self.achievements)} defs from DB")
                        return
            except Exception as e:
                print(f"⚠️ Failed reading achievements from DB: {e}")
                self.achievements = []
        # Schedule load (can be awaited if event loop running)
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(_load())
            else:
                loop.run_until_complete(_load())
        except RuntimeError:
            asyncio.run(_load())

    def get_definitions(self) -> List[Dict[str, Any]]:
        return [asdict(a) for a in self.achievements]

    # --------- Mutation (admin) ---------
    def _persist(self):
        # No file persistence; definitions live in memory + DB
        return True

    def upsert(self, data: Dict[str, Any]) -> AchievementDef | None:
        required = {"id", "icon", "name", "desc", "condition"}
        if not required.issubset(data):
            return None
        # validate condition
        cond = data["condition"]
        if not isinstance(cond, dict) or 'type' not in cond or 'value' not in cond:
            return None
        existing = next((a for a in self.achievements if a.id == data['id']), None)
        if existing:
            existing.icon = data['icon']
            existing.name = data['name']
            existing.desc = data['desc']
            existing.condition = cond
            existing.tier = data.get('tier')
        else:
            self.achievements.append(AchievementDef(
                id=data['id'], icon=data['icon'], name=data['name'], desc=data['desc'], condition=cond, tier=data.get('tier')
            ))
    # Upsert directly in DB
        async def _db():
            try:
                async for session in get_session():
                    await achievement_repository.upsert_definition(session, asdict(next(a for a in self.achievements if a.id == data['id'])))
                    await session.commit()
            except Exception as e:
                print(f"⚠️ DB upsert achievement failed: {e}")
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(_db())
            else:
                loop.run_until_complete(_db())
        except RuntimeError:
            asyncio.run(_db())
        return next((a for a in self.achievements if a.id == data['id']), None)

    def delete(self, achievement_id: str) -> bool:
        before = len(self.achievements)
        self.achievements = [a for a in self.achievements if a.id != achievement_id]
        changed = len(self.achievements) != before
        if changed:
            async def _del():
                try:
                    async for session in get_session():
                        await achievement_repository.delete_definition(session, achievement_id)
                        await session.commit()
                except Exception as e:
                    print(f"⚠️ DB delete achievement failed: {e}")
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    loop.create_task(_del())
                else:
                    loop.run_until_complete(_del())
            except RuntimeError:
                asyncio.run(_del())
        return changed

    def import_bulk(self, defs: List[Dict[str, Any]], replace: bool = False) -> dict:
        if replace:
            self.achievements = []
        added = 0
        for d in defs:
            if self.upsert(d):
                added += 1
        return {"count": added, "total": len(self.achievements)}

    # -------- Evaluation --------
    def evaluate_for_user(self, username: str, extra_counters: Dict[str, int] | None = None) -> List[str]:
        """Evaluate all achievements for user, return newly unlocked IDs.

        extra_counters can include: bulk_uses, chat_messages, session_minutes (int)
        """
        user = auth_service.get_user_by_username(username)
        if not user:
            return []
        extra_counters = extra_counters or {}

        unlocked_before = set(getattr(user, 'achievements', []) or [])
        newly_unlocked: List[str] = []

        # Derive counters from user stats
        pixels = user.total_pixels_placed
        chat_messages = extra_counters.get('chat_messages', user.total_messages_sent)
        bulk_uses = extra_counters.get('bulk_uses', getattr(user, 'bulk_placements', 0))
        # Session minutes - approximate using last login timestamp or created_at
        session_minutes = 0
        if user.last_login:
            session_minutes = int((time.time() - user.last_login.timestamp()) / 60)

        for ach in self.achievements:
            if ach.id in unlocked_before:
                continue
            cond = ach.condition
            ctype = cond.get('type')
            value = cond.get('value')
            ok = False
            if ctype == 'pixels':
                ok = pixels >= value
            elif ctype == 'bulk_uses':
                ok = bulk_uses >= value
            elif ctype == 'chat_messages':
                ok = chat_messages >= value
            elif ctype == 'session_minutes':
                ok = session_minutes >= value
            if ok:
                if auth_service.unlock_achievement(username, ach.id):
                    newly_unlocked.append(ach.id)
                    # Reward economy: coins + XP scaled by tier
                    try:
                        from app.services.xp_service import xp_service
                        tier = (ach.tier or '').lower()
                        coin_reward = 25
                        xp_reward = 20
                        if tier == 'hard':
                            coin_reward, xp_reward = 60, 50
                        elif tier == 'epic':
                            coin_reward, xp_reward = 120, 100
                        elif tier == 'legendary':
                            coin_reward, xp_reward = 250, 220
                        u = auth_service.get_user_by_username(username)
                        if u:
                            u.coins = getattr(u, 'coins', 0) + coin_reward
                            xp_service.add_xp(username, xp_reward)
                            auth_service._save_user(username)
                    except Exception as e:
                        print(f"⚠️ Failed granting achievement rewards: {e}")
        return newly_unlocked

    def validate_ids(self, ids: List[str]) -> List[str]:
        valid_ids = {a.id for a in self.achievements}
        return [i for i in ids if i in valid_ids]


achievement_service = AchievementService()
