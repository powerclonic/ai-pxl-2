"""Async database and cache initialization (PostgreSQL/SQLite + Redis).
Minimal initial schema to start migration away from flat JSON files.
"""
from __future__ import annotations
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy import String, Integer, DateTime, Boolean, JSON, UniqueConstraint, text
from datetime import datetime
from app.core.config import settings

try:
    import aioredis  # type: ignore
except ImportError:  # optional
    aioredis = None  # type: ignore

class Base(DeclarativeBase):
    pass

class UserORM(Base):
    __tablename__ = 'users'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16), default='user')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_banned: Mapped[bool] = mapped_column(Boolean, default=False)
    ban_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ban_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pixel_bag_size: Mapped[int] = mapped_column(Integer, default=3)
    max_pixel_bag_size: Mapped[int] = mapped_column(Integer, default=10)
    total_pixels_placed: Mapped[int] = mapped_column(Integer, default=0)
    total_messages_sent: Mapped[int] = mapped_column(Integer, default=0)
    experience_points: Mapped[int] = mapped_column(Integer, default=0)
    user_level: Mapped[int] = mapped_column(Integer, default=1)
    achievements: Mapped[list] = mapped_column(JSON, default=list)
    coins: Mapped[int] = mapped_column(Integer, default=0)
    owned_colors: Mapped[list] = mapped_column(JSON, default=list)
    owned_effects: Mapped[list] = mapped_column(JSON, default=list)

class ItemORM(Base):
    __tablename__ = 'items'
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    type: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(128))
    rarity: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

class LootBoxORM(Base):
    __tablename__ = 'loot_boxes'
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    price_coins: Mapped[int] = mapped_column(Integer, default=0)
    drops: Mapped[list] = mapped_column(JSON, default=list)  # list[{item_id,weight}]
    guaranteed: Mapped[list] = mapped_column(JSON, default=list)
    rarity_bonus: Mapped[dict] = mapped_column(JSON, default=dict)
    max_rolls: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

class TierORM(Base):
    __tablename__ = 'tiers'
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    label: Mapped[str] = mapped_column(String(128))
    color: Mapped[str] = mapped_column(String(16))
    weight: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

class AchievementDefORM(Base):
    __tablename__ = 'achievement_defs'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    icon: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(120))
    desc: Mapped[str] = mapped_column(String(255))
    condition: Mapped[dict] = mapped_column(JSON)
    tier: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)

class UserAchievementORM(Base):
    __tablename__ = 'user_achievements'
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(64))
    achievement_id: Mapped[str] = mapped_column(String(64))
    unlocked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    __table_args__ = (UniqueConstraint('user_id','achievement_id', name='uq_user_ach'), )

class SessionORM(Base):
    __tablename__ = 'sessions'
    token: Mapped[str] = mapped_column(String(256), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

class SchemaVersionORM(Base):
    __tablename__ = 'schema_version'
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_size=getattr(settings, 'DB_POOL_SIZE', 5),
    max_overflow=getattr(settings, 'DB_POOL_MAX_OVERFLOW', 10)
)
SessionLocal = async_sessionmaker(bind=engine, expire_on_commit=False)

redis_client = None

async def init_redis():
    global redis_client
    if getattr(settings, 'ENABLE_REDIS', False) and aioredis:
        try:
            redis_client = await aioredis.from_url(settings.REDIS_URL, encoding='utf-8', decode_responses=True)
            await redis_client.ping()
            print('✅ Redis connected')
        except Exception as e:
            print(f'⚠️ Redis init failed: {e}')

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Simple SQLite online migration for newly added columns (coins, owned_colors, owned_effects)
        try:
            res = await conn.exec_driver_sql("PRAGMA table_info(users);")
            cols = {row[1] for row in res.fetchall()}
            alter_stmts = []
            if 'coins' not in cols:
                alter_stmts.append("ALTER TABLE users ADD COLUMN coins INTEGER DEFAULT 0")
            if 'owned_colors' not in cols:
                alter_stmts.append("ALTER TABLE users ADD COLUMN owned_colors JSON DEFAULT '[]'")
            if 'owned_effects' not in cols:
                alter_stmts.append("ALTER TABLE users ADD COLUMN owned_effects JSON DEFAULT '[]'")
            for stmt in alter_stmts:
                try:
                    await conn.exec_driver_sql(stmt)
                except Exception as e:
                    print(f"⚠️ Migration stmt failed ({stmt}): {e}")
        except Exception as e:
            print(f"⚠️ Could not inspect users table: {e}")
        # Ensure schema version row
        try:
            res = await conn.exec_driver_sql("SELECT version FROM schema_version ORDER BY id DESC LIMIT 1")
            row = res.fetchone()
            if not row:
                await conn.exec_driver_sql("INSERT INTO schema_version(version) VALUES (1)")
        except Exception:
            # Table might not exist yet (older deploy) -> create manually
            try:
                await conn.exec_driver_sql("CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, applied_at TIMESTAMP)")
                await conn.exec_driver_sql("INSERT INTO schema_version(version) VALUES (1)")
            except Exception as e2:
                print(f"⚠️ Schema version ensure failed: {e2}")
    print('✅ Database schema ensured')

async def init_infrastructure():
    await init_db()
    await init_redis()

# Dependency
from typing import AsyncGenerator

async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
