from typing import List, Dict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.database import TierORM

class TierRepository:
    async def list(self, session: AsyncSession) -> List[Dict]:
        res = await session.execute(select(TierORM))
        return [ { 'key': t.key, 'label': t.label, 'color': t.color, 'weight': t.weight } for t in res.scalars().all() ]

    async def upsert_many(self, session: AsyncSession, tiers: List[Dict]):
        existing = {t['key']: t for t in await self.list(session)}
        # Insert or update changed
        for t in tiers:
            key = t['key']
            cur = existing.get(key)
            if cur and cur['label']==t['label'] and cur['color']==t['color'] and cur['weight']==t['weight']:
                continue
            # Merge
            obj = await session.get(TierORM, key)
            if not obj:
                obj = TierORM(key=key, label=t['label'], color=t['color'], weight=t['weight'])
                session.add(obj)
            else:
                obj.label = t['label']; obj.color = t['color']; obj.weight = t['weight']
        # Delete removed
        new_keys = {t['key'] for t in tiers}
        for k in list(existing.keys()):
            if k not in new_keys:
                obj = await session.get(TierORM, k)
                if obj:
                    await session.delete(obj)
        await session.commit()
        return await self.list(session)


tier_repository = TierRepository()
