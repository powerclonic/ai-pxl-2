"""
Enums used throughout the application.
"""
from enum import Enum

class MessageType(Enum):
    """WebSocket message types"""
    PIXEL_PLACE = "pixel_place"
    BULK_PIXEL_PLACE = "bulk_pixel_place"
    PIXEL_UPDATE = "pixel_update"
    PIXEL_BATCH_UPDATE = "pixel_batch_update"
    CHAT_MESSAGE = "chat_message"
    CHAT_BROADCAST = "chat_broadcast"
    USER_JOIN = "user_join"
    USER_LEAVE = "user_leave"
    REGION_DATA = "region_data"
    USER_POSITION = "user_position"
    PING = "ping"
    PONG = "pong"
    ERROR = "error"
