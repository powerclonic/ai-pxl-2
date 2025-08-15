"""Item and LootBox repositories for async DB operations."""
from __future__ import annotations
from typing import List, Optional
from sqlalchemy import select, delete
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.database import ItemORM, LootBoxORM


class ItemRepository:
    async def upsert_item(self, session: AsyncSession, data: dict):
        stmt = sqlite_insert(ItemORM).values(**data).on_conflict_do_update(
            index_elements=[ItemORM.id],
            set_={k: data[k] for k in data if k != 'id'}
        )
        await session.execute(stmt)

    async def get_item(self, session: AsyncSession, item_id: str) -> Optional[dict]:
        res = await session.execute(select(ItemORM).where(ItemORM.id == item_id))
        row = res.scalar_one_or_none()
        if not row:
            return None
        return {
            'id': row.id,
            'type': row.type,
            'name': row.name,
            'rarity': row.rarity,
            'payload': row.payload or {},
            'tags': row.tags or [],
            'created_at': row.created_at.isoformat() if row.created_at else None
        }

    async def list_items(self, session: AsyncSession) -> List[dict]:
        res = await session.execute(select(ItemORM))
        out = []
        for r in res.scalars().all():
            out.append({
                'id': r.id,
                'type': r.type,
                'name': r.name,
                'rarity': r.rarity,
                'payload': r.payload or {},
                'tags': r.tags or [],
                'created_at': r.created_at.isoformat() if r.created_at else None
            })
        return out

    async def delete_item(self, session: AsyncSession, item_id: str) -> bool:
        res = await session.execute(delete(ItemORM).where(ItemORM.id == item_id))
        return res.rowcount > 0


class LootBoxRepository:
    async def upsert_box(self, session: AsyncSession, data: dict):
        stmt = sqlite_insert(LootBoxORM).values(**data).on_conflict_do_update(
            index_elements=[LootBoxORM.id],
            set_={k: data[k] for k in data if k != 'id'}
        )
        await session.execute(stmt)

    async def get_box(self, session: AsyncSession, box_id: str) -> Optional[dict]:
        res = await session.execute(select(LootBoxORM).where(LootBoxORM.id == box_id))
        r = res.scalar_one_or_none()
        if not r:
            return None
        return {
            'id': r.id,
            'name': r.name,
            'price_coins': r.price_coins,
            'drops': r.drops or [],
            'guaranteed': r.guaranteed or [],
            'rarity_bonus': r.rarity_bonus or {},
            'max_rolls': r.max_rolls,
            'created_at': r.created_at.isoformat() if r.created_at else None
        }

    async def list_boxes(self, session: AsyncSession) -> List[dict]:
        res = await session.execute(select(LootBoxORM))
        out = []
        for r in res.scalars().all():
            out.append({
                'id': r.id,
                'name': r.name,
                'price_coins': r.price_coins,
                'drops': r.drops or [],
                'guaranteed': r.guaranteed or [],
                'rarity_bonus': r.rarity_bonus or {},
                'max_rolls': r.max_rolls,
                'created_at': r.created_at.isoformat() if r.created_at else None
            })
        return out

    async def delete_box(self, session: AsyncSession, box_id: str) -> bool:
        res = await session.execute(delete(LootBoxORM).where(LootBoxORM.id == box_id))
        return res.rowcount > 0


item_repository = ItemRepository()
loot_box_repository = LootBoxRepository()
