"""
Region manager service for handling user regions and communication.
"""
import time
import json
from datetime import datetime
from typing import Dict, List, Set, Tuple, Optional
from dataclasses import asdict
from fastapi import WebSocket

from app.models import User, ChatMessage, MessageType
from app.core.config import settings
from app.services.canvas_service import CanvasService
from app.services.user_service import UserService
from app.services.auth_service import auth_service

class RegionManager:
    """Service for managing regions and user interactions"""
    
    def __init__(self):
        self.canvas_service = CanvasService()
        self.user_service = UserService()
        self.region_connections: Dict[Tuple[int, int], Set[str]] = {}
        self.user_regions: Dict[str, Set[Tuple[int, int]]] = {}  # Track which regions each user is in
        self.chat_history: Dict[Tuple[int, int], List[ChatMessage]] = {}
        self._initialized = False
        
        # Initialize region connections and chat history
        for region_x in range(settings.REGIONS_PER_SIDE):
            for region_y in range(settings.REGIONS_PER_SIDE):
                self.region_connections[(region_x, region_y)] = set()
                self.chat_history[(region_x, region_y)] = []
                
    async def initialize(self):
        """Initialize the region manager and canvas service"""
        if not self._initialized:
            await self.canvas_service.initialize()
            self._initialized = True
            print("Region manager initialized")
            
    async def shutdown(self):
        """Shutdown the region manager"""
        if self._initialized:
            await self.canvas_service.shutdown()
            print("Region manager shutdown complete")
    
    async def connect_user(self, websocket: WebSocket, user_id: str):
        """Connect a user and place them in the center region initially"""
        center_region = (settings.REGIONS_PER_SIDE // 2, settings.REGIONS_PER_SIDE // 2)
        
        user = User(
            user_id=user_id,
            username=user_id,  # Use user_id as username for WebSocket sessions
            websocket=websocket,
            current_region_x=center_region[0],
            current_region_y=center_region[1],
            pixel_bag=settings.INITIAL_PIXEL_BAG,
            last_bag_refill=time.time()
        )
        
        self.user_service.add_user(user)
        
        # Initialize user's region set
        self.user_regions[user_id] = {center_region}
        self.region_connections[center_region].add(user_id)
        
        # Send initial region data
        await self.send_region_data(user_id, center_region[0], center_region[1])
        
        # Notify others in the region
        await self.broadcast_to_region(center_region[0], center_region[1], {
            "type": MessageType.USER_JOIN.value,
            "user_id": user_id,
            "region_x": center_region[0],
            "region_y": center_region[1],
            "users_in_region": len(self.region_connections[center_region])
        }, exclude_user=user_id)
    
    async def disconnect_user(self, user_id: str):
        """Disconnect a user and clean up"""
        user = self.user_service.get_user(user_id)
        if not user:
            return
        
        # Remove from all regions the user was connected to
        if user_id in self.user_regions:
            for region_coords in self.user_regions[user_id].copy():
                self.region_connections[region_coords].discard(user_id)
                
                # Notify others in each region
                await self.broadcast_to_region(region_coords[0], region_coords[1], {
                    "type": MessageType.USER_LEAVE.value,
                    "user_id": user_id,
                    "users_in_region": len(self.region_connections[region_coords])
                }, exclude_user=user_id)
            
            # Clear user's region tracking
            del self.user_regions[user_id]
        
        self.user_service.remove_user(user_id)
    
    async def update_user_regions(self, user_id: str, visible_regions: List[Tuple[int, int]]):
        """Update which regions a user is connected to based on their viewport"""
        user = self.user_service.get_user(user_id)
        if not user:
            return
        
        # Convert to set for easier comparison
        new_regions = set(visible_regions)
        
        # Get current regions or initialize if user not tracked
        current_regions = self.user_regions.get(user_id, set())
        
        # Find regions to add and remove
        regions_to_add = new_regions - current_regions
        regions_to_remove = current_regions - new_regions
        
        # Remove user from old regions
        for region_coords in regions_to_remove:
            if region_coords in self.region_connections:
                self.region_connections[region_coords].discard(user_id)
        
        # Add user to new regions
        for region_coords in regions_to_add:
            if region_coords in self.region_connections:
                self.region_connections[region_coords].add(user_id)
        
        # Update user's region tracking
        self.user_regions[user_id] = new_regions
        
        # Update user's primary region (for chat) to the first region
        if visible_regions:
            user.current_region_x = visible_regions[0][0]
            user.current_region_y = visible_regions[0][1]
        
        if regions_to_add or regions_to_remove:
            print(f"🗺️ User {user_id} regions updated: +{len(regions_to_add)} -{len(regions_to_remove)} = {len(new_regions)} total")
    
    async def move_user_to_region(self, user_id: str, new_region_x: int, new_region_y: int):
        """Move user to a different region"""
        user = self.user_service.get_user(user_id)
        if not user:
            return
        
        old_region = (user.current_region_x, user.current_region_y)
        new_region = (new_region_x, new_region_y)
        
        if old_region == new_region:
            return
        
        # Remove from old region
        self.region_connections[old_region].discard(user_id)
        await self.broadcast_to_region(old_region[0], old_region[1], {
            "type": MessageType.USER_LEAVE.value,
            "user_id": user_id
        }, exclude_user=user_id)
        
        # Add to new region
        self.region_connections[new_region].add(user_id)
        user.current_region_x = new_region_x
        user.current_region_y = new_region_y
        
        # Send new region data
        await self.send_region_data(user_id, new_region_x, new_region_y)
        
        # Notify others in new region
        await self.broadcast_to_region(new_region_x, new_region_y, {
            "type": MessageType.USER_JOIN.value,
            "user_id": user_id,
            "region_x": new_region_x,
            "region_y": new_region_y,
            "users_in_region": len(self.region_connections[new_region])
        }, exclude_user=user_id)
    
    async def place_pixel(self, user_id: str, x: int, y: int, color: str) -> bool:
        """Handle pixel placement with pixel bag system"""
        # Work directly with database - no more session state
        from app.services.auth_service import auth_service
        authenticated_user = auth_service.get_user_by_username(user_id)
        if not authenticated_user:
            return False
        
        current_time = time.time()
        
        # Refill pixels based on time (database version)
        auth_service.refill_user_pixels(user_id)
        
        # Re-get user after refill
        authenticated_user = auth_service.get_user_by_username(user_id)
        # Check if user has pixels in database (server authoritative guard)
        if authenticated_user.pixel_bag_size < 1:
            await self.send_to_user(user_id, {
                "type": MessageType.ERROR.value,
                "message": "No pixels available! Wait for bag to refill."
            })
            return False
        # ============ ATOMIC-ish CONSUMPTION ============
        # Decrement first, attempt placement, rollback on failure.
        # (Single-threaded event loop drastically reduces race conditions; this avoids
        # a window where a failed placement still lets user keep pixel but others saw canvas change.)
        authenticated_user.pixel_bag_size -= 1
        consume_time = datetime.now()
        try:
            placed = await self.canvas_service.place_pixel(x, y, color, user_id)
        except Exception as e:
            placed = False
            print(f"❌ Error placing pixel for {user_id} at ({x},{y}): {e}")
        if not placed:
            # Rollback consumption
            authenticated_user.pixel_bag_size += 1
            # Do NOT update last_pixel_placed_at on failure
            auth_service._save_users()
            return False

        # Successful placement: finalize stats
        authenticated_user.total_pixels_placed += 1
        authenticated_user.last_pixel_placed_at = consume_time
        auth_service._save_users()
        
        print(f"📊 User {user_id} placed a pixel! DB Bag: {authenticated_user.pixel_bag_size}/{authenticated_user.max_pixel_bag_size}")
        
        # Broadcast pixel update to all users in ALL regions where the placer is connected
        # This ensures users in adjacent regions also see the pixel update
        pixel_region_coords = self.canvas_service.get_region_coords(x, y)
        pixel_update_message = {
            "type": MessageType.PIXEL_UPDATE.value,
            "x": x,
            "y": y,
            "color": color,
            "user_id": user_id,
            "timestamp": current_time
        }
        
        # Get all regions where this user is connected
        user_connected_regions = self.user_regions.get(user_id, set())
        
        # Always broadcast to the pixel's actual region
        regions_to_broadcast = {pixel_region_coords}
        
        # Also broadcast to user's connected regions (in case pixel is near border)
        regions_to_broadcast.update(user_connected_regions)
        
        print(f"DEBUG: Broadcasting pixel update to {len(regions_to_broadcast)} regions: {regions_to_broadcast}")
        
        for region_coords in regions_to_broadcast:
            if region_coords in self.region_connections:
                await self.broadcast_to_region(region_coords[0], region_coords[1], pixel_update_message)
        
        return True
    
    async def send_chat_message(self, user_id: str, message: str):
        """Send chat message to users in the same region"""
        user = self.user_service.get_user(user_id)
        if not user:
            return
        
        region_coords = (user.current_region_x, user.current_region_y)
        
        chat_msg = ChatMessage(
            user_id=user_id,
            message=message,
            timestamp=time.time(),
            region_x=region_coords[0],
            region_y=region_coords[1]
        )
        
        # Store in chat history (keep last N messages per region)
        region_chat = self.chat_history[region_coords]
        region_chat.append(chat_msg)
        if len(region_chat) > settings.MAX_CHAT_HISTORY_PER_REGION:
            region_chat.pop(0)
        
        # Get user data for enhanced chat display
        authenticated_user = auth_service.get_user_by_username(user_id)
        user_data = {
            "username": user_id,
            "level": authenticated_user.user_level if authenticated_user else 1,
            "role": authenticated_user.role.value if authenticated_user else "USER",
            "display_name": authenticated_user.display_name if authenticated_user else None,
            "chat_color": authenticated_user.chat_color if authenticated_user else "#55aaff"
        }
        
        # Broadcast to region
        await self.broadcast_to_region(region_coords[0], region_coords[1], {
            "type": MessageType.CHAT_BROADCAST.value,
            "user_id": user_id,
            "user_data": user_data,
            "message": message,
            "timestamp": chat_msg.timestamp
        })
    
    async def send_region_data(self, user_id: str, region_x: int, region_y: int):
        """Send complete region data to a user"""
        region_data = self.canvas_service.get_region_data(region_x, region_y)
        chat_history = [
            asdict(msg) for msg in 
            self.chat_history[(region_x, region_y)][-settings.CHAT_HISTORY_RESPONSE_LIMIT:]
        ]
        
        await self.send_to_user(user_id, {
            "type": MessageType.REGION_DATA.value,
            "region_x": region_x,
            "region_y": region_y,
            "pixels": region_data,
            "chat_history": chat_history,
            "users_in_region": list(self.region_connections[(region_x, region_y)])
        })
    
    async def broadcast_to_region(self, region_x: int, region_y: int, message: dict, exclude_user: str = None):
        """Broadcast message to all users in a specific region"""
        region_coords = (region_x, region_y)
        if region_coords not in self.region_connections:
            return
        
        for user_id in self.region_connections[region_coords].copy():
            if user_id != exclude_user:
                await self.send_to_user(user_id, message)
    
    async def send_to_user(self, user_id: str, message: dict):
        """Send message to a specific user"""
        user = self.user_service.get_user(user_id)
        if not user:
            return
        
        try:
            await user.websocket.send_text(json.dumps(message))
        except Exception:
            # Connection is broken, remove user
            await self.disconnect_user(user_id)
    
    def get_stats(self) -> Dict:
        """Get current application statistics"""
        total_users = self.user_service.get_user_count()
        total_pixels = self.canvas_service.get_total_pixels()
        
        # Count users per region
        region_stats = {}
        for (region_x, region_y), users in self.region_connections.items():
            if users:  # Only include regions with users
                region_stats[f"{region_x},{region_y}"] = len(users)
        
        return {
            "total_users": total_users,
            "total_pixels": total_pixels,
            "canvas_size": settings.CANVAS_SIZE,
            "region_size": settings.REGION_SIZE,
            "regions_per_side": settings.REGIONS_PER_SIDE,
            "active_regions": region_stats,
            "pixel_refill_rate": settings.PIXEL_REFILL_RATE
        }
