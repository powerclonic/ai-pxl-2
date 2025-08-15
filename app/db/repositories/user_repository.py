"""User repository for async DB operations."""
from __future__ import annotations
from typing import List
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.database import UserORM
from app.models.models import AuthenticatedUser, UserRole


def _to_dataclass(row: UserORM) -> AuthenticatedUser:
    return AuthenticatedUser(
        id=row.id,
        username=row.id,
        password_hash=row.password_hash,
        role=UserRole(row.role),
        created_at=row.created_at,
        last_login=row.last_login,
        is_banned=row.is_banned,
        ban_expires_at=row.ban_expires_at,
        ban_reason=row.ban_reason,
        failed_login_attempts=0,
        pixel_bag_size=row.pixel_bag_size,
        max_pixel_bag_size=row.max_pixel_bag_size,
        total_pixels_placed=row.total_pixels_placed,
        total_messages_sent=row.total_messages_sent,
        experience_points=row.experience_points,
        user_level=row.user_level,
        achievements=row.achievements or [],
    coins=getattr(row, 'coins', 0),
    owned_colors=getattr(row, 'owned_colors', []) or [],
    owned_effects=getattr(row, 'owned_effects', []) or [],
        last_pixel_placed_at=None,
        last_message_sent_at=None,
        display_name=None,
        chat_color=None,
        preferences={}
    )


class UserRepository:
    async def upsert_user(self, session: AsyncSession, user: AuthenticatedUser) -> None:
        stmt = sqlite_insert(UserORM).values(
            id=user.username,
            password_hash=user.password_hash,
            role=user.role.value,
            created_at=user.created_at,
            last_login=user.last_login,
            is_banned=user.is_banned,
            ban_expires_at=user.ban_expires_at,
            ban_reason=user.ban_reason,
            pixel_bag_size=user.pixel_bag_size,
            max_pixel_bag_size=user.max_pixel_bag_size,
            total_pixels_placed=user.total_pixels_placed,
            total_messages_sent=user.total_messages_sent,
            experience_points=user.experience_points,
            user_level=user.user_level,
            achievements=user.achievements,
            coins=user.coins,
            owned_colors=user.owned_colors,
            owned_effects=user.owned_effects,
        ).on_conflict_do_update(
            index_elements=[UserORM.id],
            set_={  # NOTE: dialect expects set_ (underscore) for SQLite
                'password_hash': user.password_hash,
                'role': user.role.value,
                'last_login': user.last_login,
                'is_banned': user.is_banned,
                'ban_expires_at': user.ban_expires_at,
                'ban_reason': user.ban_reason,
                'pixel_bag_size': user.pixel_bag_size,
                'max_pixel_bag_size': user.max_pixel_bag_size,
                'total_pixels_placed': user.total_pixels_placed,
                'total_messages_sent': user.total_messages_sent,
                'experience_points': user.experience_points,
                'user_level': user.user_level,
                'achievements': user.achievements,
                'coins': user.coins,
                'owned_colors': user.owned_colors,
                'owned_effects': user.owned_effects,
            }
        )
        await session.execute(stmt)

    async def get_user(self, session: AsyncSession, username: str) -> AuthenticatedUser | None:
        res = await session.execute(select(UserORM).where(UserORM.id == username))
        row = res.scalar_one_or_none()
        return _to_dataclass(row) if row else None

    async def get_all_users(self, session: AsyncSession) -> List[AuthenticatedUser]:
        res = await session.execute(select(UserORM))
        return [_to_dataclass(r) for r in res.scalars().all()]


user_repository = UserRepository()
