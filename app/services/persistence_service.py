"""
Persistence service for saving and loading user data and game state.
"""
import json
import os
from datetime import datetime
from typing import Dict, Optional
from dataclasses import asdict
from app.models.models import AuthenticatedUser, UserRole
from app.core.config import settings

class PersistenceService:
    """LEGACY: File-based persistence retained only for bootstrap/migration fallback.

    Users and achievements now stored in the database; stats counters via Redis/DB.
    Canvas handled by CanvasPersistence (Parquet). Avoid adding new logic here.
    """
    
    def __init__(self):
        self.data_dir = "data"
        self.users_file = os.path.join(self.data_dir, "users.json")
        self.stats_file = os.path.join(self.data_dir, "stats.json")
        self.canvas_backup_file = os.path.join(self.data_dir, "canvas_backup.json")
        self.sessions_file = os.path.join(self.data_dir, "sessions.json")
        
        # Ensure data directory exists
        os.makedirs(self.data_dir, exist_ok=True)
    
    def save_users(self, users: Dict[str, AuthenticatedUser]) -> bool:
        """Save all users to file"""
        try:
            users_data = {}
            for user_id, user in users.items():
                user_dict = asdict(user)
                # Convert datetime objects to ISO strings
                if user_dict['created_at']:
                    user_dict['created_at'] = user.created_at.isoformat()
                if user_dict['last_login']:
                    user_dict['last_login'] = user.last_login.isoformat()
                if user_dict['ban_expires_at']:
                    user_dict['ban_expires_at'] = user.ban_expires_at.isoformat()
                if user_dict['last_pixel_placed_at']:
                    user_dict['last_pixel_placed_at'] = user.last_pixel_placed_at.isoformat()
                if user_dict['last_message_sent_at']:
                    user_dict['last_message_sent_at'] = user.last_message_sent_at.isoformat()
                
                # Convert enum to string
                user_dict['role'] = user.role.value
                
                users_data[user_id] = user_dict
            
            with open(self.users_file, 'w') as f:
                json.dump(users_data, f, indent=2)
            
            return True
        except Exception as e:
            print(f"Error saving users: {e}")
            return False
    
    def load_users(self) -> Dict[str, AuthenticatedUser]:
        """Load all users from file"""
        try:
            if not os.path.exists(self.users_file):
                return {}
            
            with open(self.users_file, 'r') as f:
                users_data = json.load(f)
            
            users = {}
            for user_id, user_dict in users_data.items():
                # Convert ISO strings back to datetime objects
                if user_dict['created_at']:
                    user_dict['created_at'] = datetime.fromisoformat(user_dict['created_at'])
                if user_dict['last_login']:
                    user_dict['last_login'] = datetime.fromisoformat(user_dict['last_login'])
                if user_dict['ban_expires_at']:
                    user_dict['ban_expires_at'] = datetime.fromisoformat(user_dict['ban_expires_at'])
                if user_dict['last_pixel_placed_at']:
                    user_dict['last_pixel_placed_at'] = datetime.fromisoformat(user_dict['last_pixel_placed_at'])
                if user_dict['last_message_sent_at']:
                    user_dict['last_message_sent_at'] = datetime.fromisoformat(user_dict['last_message_sent_at'])
                
                # Convert string back to enum
                user_dict['role'] = UserRole(user_dict['role'])
                
                # Handle missing fields for backward compatibility
                user_dict.setdefault('pixel_bag_size', settings.INITIAL_PIXEL_BAG)
                user_dict.setdefault('max_pixel_bag_size', settings.MAX_PIXEL_BAG)
                user_dict.setdefault('total_pixels_placed', 0)
                user_dict.setdefault('total_messages_sent', 0)
                user_dict.setdefault('total_login_time_seconds', 0)
                user_dict.setdefault('last_pixel_placed_at', None)
                user_dict.setdefault('last_message_sent_at', None)
                user_dict.setdefault('user_level', 1)
                user_dict.setdefault('experience_points', 0)
                user_dict.setdefault('achievements', [])
                user_dict.setdefault('preferences', {})
                # New economy / progression fields
                user_dict.setdefault('coins', 0)
                user_dict.setdefault('premium_coins', 0)
                user_dict.setdefault('inventory', {})
                user_dict.setdefault('owned_colors', [])
                user_dict.setdefault('owned_effects', [])
                user_dict.setdefault('owned_colors', [])
                user_dict.setdefault('coins', 0)
                user_dict.setdefault('last_lootbox_open_at', None)
                user_dict.setdefault('lootbox_opens', 0)
                user_dict.setdefault('xp_to_next_cache', 0)
                
                users[user_id] = AuthenticatedUser(**user_dict)
            
            return users
        except Exception as e:
            print(f"Error loading users: {e}")
            return {}
    
    def save_stats(self, stats: dict) -> bool:  # Deprecated
        return False
    
    def load_stats(self) -> dict:  # Deprecated
        return {}
    
    def backup_canvas_data(self, canvas_data: dict) -> bool:
        """Backup canvas data"""
        try:
            backup_data = {
                'timestamp': datetime.now().isoformat(),
                'canvas_data': canvas_data
            }
            
            with open(self.canvas_backup_file, 'w') as f:
                json.dump(backup_data, f, indent=2)
            
            return True
        except Exception as e:
            print(f"Error backing up canvas: {e}")
            return False
    
    def restore_canvas_data(self) -> Optional[dict]:
        """Restore canvas data from backup"""
        try:
            if not os.path.exists(self.canvas_backup_file):
                return None
            
            with open(self.canvas_backup_file, 'r') as f:
                backup_data = json.load(f)
            
            return backup_data.get('canvas_data')
        except Exception as e:
            print(f"Error restoring canvas: {e}")
            return None
    
    def save_sessions(self, session_tokens: dict, session_locks: dict) -> bool:
        """Save session tokens and locks"""
        try:
            sessions_data = {
                'session_tokens': session_tokens,
                'session_locks': session_locks,
                'timestamp': datetime.now().isoformat()
            }
            
            with open(self.sessions_file, 'w') as f:
                json.dump(sessions_data, f, indent=2)
            
            return True
        except Exception as e:
            print(f"Error saving sessions: {e}")
            return False
    
    def load_sessions(self) -> tuple[dict, dict]:
        """Load session tokens and locks"""
        try:
            if not os.path.exists(self.sessions_file):
                return {}, {}
            
            with open(self.sessions_file, 'r') as f:
                sessions_data = json.load(f)
            
            session_tokens = sessions_data.get('session_tokens', {})
            session_locks = sessions_data.get('session_locks', {})
            
            # Clean up old locks (older than 1 hour)
            current_time = datetime.now().timestamp()
            cleaned_locks = {}
            for user_id, lock_time in session_locks.items():
                if current_time - lock_time < 3600:  # 1 hour
                    cleaned_locks[user_id] = lock_time
            
            return session_tokens, cleaned_locks
        except Exception as e:
            print(f"Error loading sessions: {e}")
            return {}, {}

# Global persistence service instance
persistence_service = PersistenceService()
