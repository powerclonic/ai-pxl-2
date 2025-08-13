"""
Data models for the Pixel Canvas application.
"""
from dataclasses import dataclass
from typing import Dict, Set
from fastapi import WebSocket

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
    """Represents a connected user"""
    user_id: str
    websocket: WebSocket
    current_region_x: int
    current_region_y: int
    pixel_bag: int = 3
    last_bag_refill: float = 0

@dataclass
class RegionInfo:
    """Information about a canvas region"""
    region_x: int
    region_y: int
    pixels: Dict[tuple, Pixel]
    connected_users: Set[str]
    chat_history: list[ChatMessage]
