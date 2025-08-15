"""Session repository for persisting auth sessions in DB."""
from __future__ import annotations
from sqlalchemy import select, delete, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime
from app.db.database import SessionORM
from typing import List

class SessionRepository:
    async def upsert(self, session: AsyncSession, token: str, user_id: str):
        stmt = sqlite_insert(SessionORM).values(token=token, user_id=user_id).on_conflict_do_update(
            index_elements=[SessionORM.token],
            set_={'user_id': user_id, 'last_seen': datetime.utcnow()}
        )
        await session.execute(stmt)

    async def touch(self, session: AsyncSession, token: str):
        await session.execute(update(SessionORM).where(SessionORM.token == token).values(last_seen=datetime.utcnow()))

    async def delete(self, session: AsyncSession, token: str):
        await session.execute(delete(SessionORM).where(SessionORM.token == token))

    async def delete_user_sessions_except(self, session: AsyncSession, user_id: str, keep_token: str):
        await session.execute(delete(SessionORM).where(SessionORM.user_id == user_id, SessionORM.token != keep_token))

    async def list_for_user(self, session: AsyncSession, user_id: str) -> List[str]:
        res = await session.execute(select(SessionORM.token).where(SessionORM.user_id == user_id))
        return [r[0] for r in res.all()]

    async def load_all(self, session: AsyncSession) -> dict:
        res = await session.execute(select(SessionORM))
        return {r.token: r.user_id for r in res.scalars().all()}

session_repository = SessionRepository()
