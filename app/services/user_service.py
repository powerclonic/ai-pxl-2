"""
User service for managing user operations and pixel bag system.
"""
import time
from datetime import datetime
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
            # Get user's specific max bag size from auth service - NO HARDCODED LIMITS
            from app.services.auth_service import auth_service
            authenticated_user = auth_service.get_user_by_username(user.user_id)
            if not authenticated_user:
                print(f"❌ No authenticated user found for {user.user_id}")
                return 0
            
            max_bag = authenticated_user.max_pixel_bag_size  # Use ONLY the user's specific limit
            
            old_count = user.pixel_bag
            user.pixel_bag = min(max_bag, user.pixel_bag + pixels_to_add)
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
        """Consume a pixel from user's bag and update stats"""
        user = self.get_user(user_id)
        if not user or user.pixel_bag <= 0:
            return False
        
        # Consume pixel from bag
        user.pixel_bag -= 1
        
        # Update statistics via auth_service
        from app.services.auth_service import auth_service
        auth_service.update_user_stats(user_id, pixels_placed=1)
        
        print(f"📊 User {user.username} placed a pixel! Bag: {user.pixel_bag}")
        
        return True
    
    def get_pixel_bag_info(self, user_id: str) -> Dict:
        """Get pixel bag information for a user"""
        user = self.get_user(user_id)
        if not user:
            # If no WebSocket user, try to get from auth service
            from app.services.auth_service import auth_service
            authenticated_user = auth_service.get_user_by_username(user_id)
            if authenticated_user:
                return {
                    "pixels": authenticated_user.pixel_bag_size,
                    "max_pixels": authenticated_user.max_pixel_bag_size,
                    "refill_rate": settings.PIXEL_REFILL_RATE
                }
            return {"pixels": 0, "max_pixels": 0}
        
        # Get user's specific max bag size from auth service - NO HARDCODED LIMITS
        from app.services.auth_service import auth_service
        authenticated_user = auth_service.get_user_by_username(user_id)
        if not authenticated_user:
            print(f"❌ No authenticated user found for {user_id}")
            return {"pixels": 0, "max_pixels": 0}
        
        max_bag = authenticated_user.max_pixel_bag_size  # Use ONLY the user's specific limit
        
        # Refresh pixel bag
        self.refill_pixel_bag(user, time.time())
        
        return {
            "pixels": user.pixel_bag,
            "max_pixels": max_bag,
            "refill_rate": settings.PIXEL_REFILL_RATE
        }
