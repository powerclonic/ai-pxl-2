"""
Data models for the Pixel Canvas application.
"""
from dataclasses import dataclass, field
from typing import Dict, Set, Optional
from fastapi import WebSocket
from app.core.config import settings
from datetime import datetime
from enum import Enum

class UserRole(Enum):
    """User role enumeration"""
    USER = "USER"
    ADMIN = "ADMIN"
    BANNED = "BANNED"

@dataclass
class AuthenticatedUser:
    """Represents an authenticated user with full authentication data"""
    id: str
    username: str
    password_hash: str
    role: UserRole = UserRole.USER
    created_at: datetime = field(default_factory=datetime.now)
    last_login: Optional[datetime] = None
    is_banned: bool = False
    ban_expires_at: Optional[datetime] = None
    ban_reason: Optional[str] = None
    failed_login_attempts: int = 0
    
    # User stats and metadata
    pixel_bag_size: int = field(default_factory=lambda: settings.INITIAL_PIXEL_BAG)
    max_pixel_bag_size: int = field(default_factory=lambda: settings.MAX_PIXEL_BAG)
    total_pixels_placed: int = 0
    total_messages_sent: int = 0
    total_login_time_seconds: int = 0
    last_pixel_placed_at: Optional[datetime] = None
    # Independent refill anchor for pixel bag regeneration (previously reused last_pixel_placed_at causing stalls when idle)
    last_bag_refill_at: Optional[datetime] = field(default_factory=datetime.now)
    last_message_sent_at: Optional[datetime] = None
    user_level: int = 1
    experience_points: int = 0
    achievements: list = field(default_factory=list)
    preferences: dict = field(default_factory=dict)
    # Economy / progression
    coins: int = 0
    premium_coins: int = 0  # future use
    inventory: dict = field(default_factory=dict)  # generic item_id -> count / meta
    owned_colors: list = field(default_factory=list)  # list of unlocked color IDs
    owned_effects: list = field(default_factory=list)  # list of unlocked effect IDs
    last_lootbox_open_at: Optional[datetime] = None
    lootbox_opens: int = 0
    xp_to_next_cache: int = 0  # cached threshold for current level
    
    # Chat customization
    display_name: Optional[str] = None
    chat_color: str = "#55aaff"
    # Reward throttling state
    reward_window_start: Optional[datetime] = None
    reward_actions_in_window: int = 0

    # Convenience helpers
    def is_admin(self) -> bool:
        return self.role == UserRole.ADMIN and not self.is_banned

    def is_banned_user(self) -> bool:
        return self.is_banned or self.role == UserRole.BANNED

@dataclass
class CaptchaChallenge:
    """CAPTCHA challenge for bot protection"""
    challenge_id: str
    user_id: str
    question: str
    answer: str
    created_at: datetime
    expires_at: datetime

@dataclass
class Pixel:
    """Represents a pixel on the canvas"""
    x: int
    y: int
    color: str
    timestamp: float
    user_id: str

@dataclass
class ChatMessage:
    """Represents a chat message in a region"""
    user_id: str
    message: str
    timestamp: float
    region_x: int
    region_y: int

@dataclass
class User:
    """Represents a connected user session"""
    user_id: str
    username: str
    websocket: WebSocket
    current_region_x: int
    current_region_y: int
    pixel_bag: int = settings.INITIAL_PIXEL_BAG
    last_bag_refill: float = 0
    role: UserRole = UserRole.USER
    is_authenticated: bool = False
    last_action_time: float = field(default_factory=lambda: datetime.now().timestamp())
    actions_per_minute: int = 0
    actions_reset_time: float = field(default_factory=lambda: datetime.now().timestamp())

@dataclass
class RegionInfo:
    """Information about a canvas region"""
    region_x: int
    region_y: int
    pixels: Dict[tuple, Pixel]
    connected_users: Set[str]
    chat_history: list[ChatMessage]
