"""
User service for managing user operations and pixel bag system.
"""
import time
from typing import Dict, Optional
from app.models import User
from app.core.config import settings

class UserService:
    """Service for managing user operations"""
    
    def __init__(self):
        self.users: Dict[str, User] = {}
    
    def add_user(self, user: User) -> None:
        """Add a user to the service"""
        self.users[user.user_id] = user
    
    def remove_user(self, user_id: str) -> Optional[User]:
        """Remove a user from the service"""
        return self.users.pop(user_id, None)
    
    def get_user(self, user_id: str) -> Optional[User]:
        """Get a user by ID"""
        return self.users.get(user_id)
    
    def get_user_count(self) -> int:
        """Get total number of connected users"""
        return len(self.users)
    
    def refill_pixel_bag(self, user: User, current_time: float) -> int:
        """Refill user's pixel bag based on time passed"""
        time_passed = current_time - user.last_bag_refill
        pixels_to_add = int(time_passed // settings.PIXEL_REFILL_RATE)
        
        if pixels_to_add > 0:
            old_count = user.pixel_bag
            user.pixel_bag = min(settings.MAX_PIXEL_BAG, user.pixel_bag + pixels_to_add)
            user.last_bag_refill = current_time
            return user.pixel_bag - old_count
        return 0
    
    def can_place_pixel(self, user_id: str) -> bool:
        """Check if user can place a pixel"""
        user = self.get_user(user_id)
        if not user:
            return False
        
        # Refresh pixel bag
        self.refill_pixel_bag(user, time.time())
        return user.pixel_bag > 0
    
    def consume_pixel(self, user_id: str) -> bool:
        """Consume a pixel from user's bag"""
        user = self.get_user(user_id)
        if not user or user.pixel_bag <= 0:
            return False
        
        user.pixel_bag -= 1
        return True
    
    def get_pixel_bag_info(self, user_id: str) -> Dict:
        """Get pixel bag information for a user"""
        user = self.get_user(user_id)
        if not user:
            return {"pixels": 0, "max_pixels": settings.MAX_PIXEL_BAG}
        
        # Refresh pixel bag
        self.refill_pixel_bag(user, time.time())
        
        return {
            "pixels": user.pixel_bag,
            "max_pixels": settings.MAX_PIXEL_BAG,
            "refill_rate": settings.PIXEL_REFILL_RATE
        }
