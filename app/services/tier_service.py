from typing import List, Dict
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.database import SessionLocal
from app.db.repositories.tier_repository import tier_repository

DEFAULT_TIERS = [
    {"key":"common","label":"Common","color":"#b0b0b0","weight":60},
    {"key":"rare","label":"Rare","color":"#4d7dff","weight":25},
    {"key":"epic","label":"Epic","color":"#b24dff","weight":12},
    {"key":"legendary","label":"Legendary","color":"#ffae00","weight":3},
]

_TIERS_CACHE: List[Dict] | None = None

async def get_tiers(session: AsyncSession | None = None, force_refresh: bool=False) -> List[Dict]:
    global _TIERS_CACHE
    if _TIERS_CACHE is not None and not force_refresh:
        return [dict(t) for t in _TIERS_CACHE]
    close = False
    if session is None:
        session = SessionLocal(); close=True
    try:
        tiers = await tier_repository.list(session)
        if not tiers:
            await tier_repository.upsert_many(session, DEFAULT_TIERS)
            tiers = await tier_repository.list(session)
        _TIERS_CACHE = [dict(t) for t in tiers]
        return [dict(t) for t in tiers]
    finally:
        if close:
            await session.close()

def _validate_tiers(tiers: List[Dict]) -> List[Dict]:
    keys_seen = set(); normalized=[]
    if not tiers: raise ValueError('Empty tiers')
    for t in tiers:
        if not isinstance(t, dict): raise ValueError('Tier not object')
        key = str(t.get('key','')).strip().lower()
        label = str(t.get('label','')).strip() or key.capitalize()
        color = str(t.get('color','')).strip()
        weight = int(t.get('weight',0))
        if not key or key in keys_seen: raise ValueError('Duplicate/empty key')
        keys_seen.add(key)
        if not color.startswith('#') or len(color) not in (4,7): raise ValueError(f'Invalid color {color}')
        if weight <= 0: raise ValueError('Weight must be > 0')
        normalized.append({"key":key,"label":label,"color":color,"weight":weight})
    return normalized

async def save_tiers(tiers: List[Dict], session: AsyncSession | None = None) -> List[Dict]:
    normalized = _validate_tiers(tiers)
    close = False
    if session is None:
        session = SessionLocal()
        close = True
    try:
        saved = await tier_repository.upsert_many(session, normalized)
        # Invalidate cache
        global _TIERS_CACHE
        _TIERS_CACHE = [dict(t) for t in saved]
        return saved
    finally:
        if close:
            await session.close()
