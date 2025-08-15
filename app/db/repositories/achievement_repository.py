"""Achievement repository for async DB operations."""
from __future__ import annotations
from typing import List
from sqlalchemy import select, delete
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.database import AchievementDefORM, UserAchievementORM

class AchievementRepository:
    async def upsert_definition(self, session: AsyncSession, data: dict):
        stmt = sqlite_insert(AchievementDefORM).values(**data).on_conflict_do_update(
            index_elements=[AchievementDefORM.id],
            set_={k: data[k] for k in data if k != 'id'}
        )
        await session.execute(stmt)

    async def delete_definition(self, session: AsyncSession, ach_id: str) -> bool:
        res = await session.execute(delete(AchievementDefORM).where(AchievementDefORM.id == ach_id))
        return res.rowcount > 0

    async def list_definitions(self, session: AsyncSession) -> List[dict]:
        res = await session.execute(select(AchievementDefORM))
        return [
            {
                'id': r.id,
                'icon': r.icon,
                'name': r.name,
                'desc': r.desc,
                'condition': r.condition,
                'tier': r.tier,
                'updated_at': r.updated_at.isoformat() if r.updated_at else None
            } for r in res.scalars().all()
        ]

    async def unlock(self, session: AsyncSession, user_id: str, achievement_id: str) -> bool:
        stmt = sqlite_insert(UserAchievementORM).values(user_id=user_id, achievement_id=achievement_id)
        stmt = stmt.prefix_with("OR IGNORE")  # sqlite-specific
        await session.execute(stmt)
        return True

    async def list_user_achievements(self, session: AsyncSession, user_id: str) -> List[str]:
        res = await session.execute(select(UserAchievementORM.achievement_id).where(UserAchievementORM.user_id == user_id))
        return [row[0] for row in res.all()]

achievement_repository = AchievementRepository()
