"""
Authentication service for user management, login, and security.
"""
import hashlib
import secrets
import time
from datetime import datetime, timedelta
from typing import Optional, Dict, List
from dataclasses import dataclass, field
import random
import jwt
import asyncio

from app.db.database import get_session
from app.db.repositories.user_repository import user_repository
from app.db.database import redis_client

from app.core.config import Settings
from app.models.models import User, AuthenticatedUser, UserRole, CaptchaChallenge
from app.services.persistence_service import persistence_service


class AuthService:
    """Handles authentication, rate limiting, and security measures"""
    
    def __init__(self):
        self.settings = Settings()
        self.users: Dict[str, AuthenticatedUser] = {}
        self.rate_limits: Dict[str, List[float]] = {}  # user_id -> [timestamp, ...]
        self.captcha_challenges: Dict[str, CaptchaChallenge] = {}
        self.failed_attempts: Dict[str, int] = {}  # user_id -> count
        self.session_tokens: Dict[str, str] = {}  # token -> user_id
        self.session_locks: Dict[str, float] = {}  # user_id -> timestamp (for race condition prevention)
        
        # Async load from DB (fallback to JSON seed)
        self._bootstrap_done = False
        async def _bootstrap():
            loaded_from = "db"
            try:
                async for session in get_session():
                    db_users = await user_repository.get_all_users(session)
                    if db_users:
                        self.users = {u.username: u for u in db_users}
                    else:
                        # Fallback seed from JSON persistence
                        self.users = persistence_service.load_users()
                        loaded_from = "json"
                        # Seed DB
                        for u in self.users.values():
                            await user_repository.upsert_user(session, u)
                        await session.commit()
            except Exception as e:
                print(f"⚠️ User bootstrap failed: {e}; using JSON only")
                if not self.users:
                    self.users = persistence_service.load_users()
                    loaded_from = "json-error"
            # Load sessions (still file-based)
            self.session_tokens, self.session_locks = persistence_service.load_sessions()
            print(f"✅ Loaded {len(self.users)} users from {loaded_from} | sessions={len(self.session_tokens)}")
            # Ensure default admin exists (and persisted)
            self._create_default_admin()
            async for session in get_session():
                await user_repository.upsert_user(session, self.users[self.settings.DEFAULT_ADMIN_USERNAME])
                await session.commit()
            self._bootstrap_done = True
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(_bootstrap())
            else:
                loop.run_until_complete(_bootstrap())
        except RuntimeError:
            asyncio.run(_bootstrap())
    
    def _create_default_admin(self):
        """Create default admin user if it doesn't exist"""
        admin_id = self.settings.DEFAULT_ADMIN_USERNAME
        if admin_id not in self.users:
            hashed_password = self._hash_password(self.settings.DEFAULT_ADMIN_PASSWORD)
            admin_user = AuthenticatedUser(
                id=admin_id,
                username=admin_id,
                password_hash=hashed_password,
                role=UserRole.ADMIN,
                created_at=datetime.now(),
                last_login=None,
                is_banned=False,
                ban_expires_at=None,
                ban_reason=None,
                failed_login_attempts=0
            )
            self.users[admin_id] = admin_user
            print(f"✅ Default admin user created: {admin_id}")
    
    def _hash_password(self, password: str) -> str:
        """Hash password with salt"""
        salt = secrets.token_hex(16)
        pwd_hash = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000)
        return f"{salt}:{pwd_hash.hex()}"
    
    def _verify_password(self, password: str, hash_str: str) -> bool:
        """Verify password against hash"""
        try:
            salt, pwd_hash = hash_str.split(':')
            computed_hash = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000)
            return computed_hash.hex() == pwd_hash
        except ValueError:
            return False
    
    def _generate_token(self, user_id: str) -> str:
        """Generate JWT token for user"""
        payload = {
            'user_id': user_id,
            'exp': datetime.utcnow() + timedelta(minutes=self.settings.ACCESS_TOKEN_EXPIRE_MINUTES),
            'iat': datetime.utcnow()
        }
        token = jwt.encode(payload, self.settings.SECRET_KEY, algorithm=self.settings.ALGORITHM)
        self.session_tokens[token] = user_id
        return token
    
    def _validate_token(self, token: str) -> Optional[str]:
        """Validate JWT token and return user_id"""
        try:
            payload = jwt.decode(token, self.settings.SECRET_KEY, algorithms=[self.settings.ALGORITHM])
            user_id = payload.get('user_id')
            if token in self.session_tokens and self.session_tokens[token] == user_id:
                return user_id
            return None
        except jwt.InvalidTokenError:
            return None
    
    def register_user(self, username: str, password: str) -> tuple[bool, str]:
        """Register a new user"""
        # Validate input
        if len(username) < self.settings.MIN_USERNAME_LENGTH:
            return False, f"Username must be at least {self.settings.MIN_USERNAME_LENGTH} characters"
        if len(username) > self.settings.MAX_USERNAME_LENGTH:
            return False, f"Username must be at most {self.settings.MAX_USERNAME_LENGTH} characters"
        if len(password) < self.settings.MIN_PASSWORD_LENGTH:
            return False, f"Password must be at least {self.settings.MIN_PASSWORD_LENGTH} characters"
        
        # Check if user exists
        if username in self.users:
            return False, "Username already exists"
        
        # Create user
        hashed_password = self._hash_password(password)
        user = AuthenticatedUser(
            id=username,
            username=username,
            password_hash=hashed_password,
            role=UserRole.USER,
            created_at=datetime.now(),
            last_login=None,
            is_banned=False,
            ban_expires_at=None,
            ban_reason=None,
            failed_login_attempts=0
        )
        
        self.users[username] = user
        self._save_users()
        return True, "User registered successfully"
    
    def login_user(self, username: str, password: str, captcha_answer: Optional[str] = None) -> tuple[bool, str, Optional[str]]:
        """Login user and return (success, message, token)"""
        if username not in self.users:
            return False, "Invalid username or password", None
        
        user = self.users[username]
        
        # Check if user is banned
        if user.is_banned:
            if user.ban_expires_at and datetime.now() > user.ban_expires_at:
                # Unban expired temporary ban
                user.is_banned = False
                user.ban_expires_at = None
                user.ban_reason = None
            else:
                ban_msg = f"Account banned"
                if user.ban_reason:
                    ban_msg += f": {user.ban_reason}"
                if user.ban_expires_at:
                    ban_msg += f" (expires: {user.ban_expires_at.strftime('%Y-%m-%d %H:%M')})"
                return False, ban_msg, None
        
        # Check if CAPTCHA is required
        if user.failed_login_attempts >= self.settings.CAPTCHA_REQUIRED_AFTER_FAILURES:
            if not captcha_answer:
                challenge = self.generate_captcha_challenge(username)
                return False, f"CAPTCHA required: {challenge.question}", None
            
            if not self.verify_captcha(username, captcha_answer):
                user.failed_login_attempts += 1
                if user.failed_login_attempts >= self.settings.MAX_FAILED_CAPTCHA_ATTEMPTS:
                    self.ban_user(username, "Too many failed CAPTCHA attempts", temporary=True)
                    return False, "Account temporarily banned due to failed CAPTCHA attempts", None
                return False, "Incorrect CAPTCHA answer", None
        
        # Verify password
        if not self._verify_password(password, user.password_hash):
            user.failed_login_attempts += 1
            return False, "Invalid username or password", None
        
        # Successful login
        user.failed_login_attempts = 0
        user.last_login = datetime.now()
        token = self.create_secure_session(username)
        
        if not token:
            return False, "Login failed due to concurrent access. Please try again.", None
        
        return True, "Login successful", token
    
    def logout_user(self, token: str) -> bool:
        """Logout user by invalidating token"""
        if token in self.session_tokens:
            del self.session_tokens[token]
            return True
        return False
    
    def get_current_user(self, token: str) -> Optional[AuthenticatedUser]:
        """Get current user from token (supports both session tokens and JWT)"""
        # First try session tokens (new system)
        if token in self.session_tokens:
            user_id = self.session_tokens[token]
            if user_id in self.users:
                return self.users[user_id]
        
        # Fallback to JWT validation (legacy support)
        user_id = self._validate_token(token)
        if user_id and user_id in self.users:
            return self.users[user_id]
        
        return None
    
    def generate_captcha_challenge(self, user_id: str) -> CaptchaChallenge:
        """Generate a CAPTCHA challenge"""
        # Simple math CAPTCHA
        a = random.randint(1, 20)
        b = random.randint(1, 20)
        operation = random.choice(['+', '-', '*'])
        
        if operation == '+':
            answer = a + b
            question = f"What is {a} + {b}?"
        elif operation == '-':
            if a < b:
                a, b = b, a  # Ensure positive result
            answer = a - b
            question = f"What is {a} - {b}?"
        else:  # multiplication
            answer = a * b
            question = f"What is {a} × {b}?"
        
        challenge = CaptchaChallenge(
            challenge_id=secrets.token_urlsafe(16),
            user_id=user_id,
            question=question,
            answer=str(answer),
            created_at=datetime.now(),
            expires_at=datetime.now() + timedelta(minutes=self.settings.CAPTCHA_EXPIRE_MINUTES)
        )
        
        self.captcha_challenges[user_id] = challenge
        return challenge
    
    def verify_captcha(self, user_id: str, answer: str) -> bool:
        """Verify CAPTCHA answer"""
        if user_id not in self.captcha_challenges:
            return False
        
        challenge = self.captcha_challenges[user_id]
        
        # Check if expired
        if datetime.now() > challenge.expires_at:
            del self.captcha_challenges[user_id]
            return False
        
        # Check answer
        is_correct = challenge.answer.strip() == answer.strip()
        
        # Remove challenge after verification
        del self.captcha_challenges[user_id]
        
        return is_correct
    
    def check_rate_limit(self, user_id: str) -> bool:
        """Check if user is within rate limits"""
        now = time.time()
        minute_ago = now - 60
        
        if user_id not in self.rate_limits:
            self.rate_limits[user_id] = []
        
        # Remove old timestamps
        self.rate_limits[user_id] = [ts for ts in self.rate_limits[user_id] if ts > minute_ago]
        
        # Check limit
        if len(self.rate_limits[user_id]) >= self.settings.MAX_ACTIONS_PER_MINUTE:
            return False
        
        # Add current timestamp
        self.rate_limits[user_id].append(now)
        return True
    
    def ban_user(self, username: str, reason: str, temporary: bool = False) -> bool:
        """Ban a user"""
        if username not in self.users:
            return False
        
        user = self.users[username]
        user.is_banned = True
        user.ban_reason = reason
        
        if temporary:
            user.ban_expires_at = datetime.now() + timedelta(hours=self.settings.TEMP_BAN_DURATION_HOURS)
        else:
            user.ban_expires_at = None
        
        # Invalidate all user's tokens
        tokens_to_remove = [token for token, uid in self.session_tokens.items() if uid == username]
        for token in tokens_to_remove:
            del self.session_tokens[token]
        
        return True
    
    def unban_user(self, username: str) -> bool:
        """Unban a user"""
        if username not in self.users:
            return False
        
        user = self.users[username]
        user.is_banned = False
        user.ban_expires_at = None
        user.ban_reason = None
        user.failed_login_attempts = 0
        
        return True
    
    def get_all_users(self) -> List[AuthenticatedUser]:
        """Get all users (admin only)"""
        return list(self.users.values())
    
    def is_admin(self, user: AuthenticatedUser) -> bool:
        """Check if user is admin"""
        return user.role == UserRole.ADMIN
    
    def create_secure_session(self, user_id: str) -> str:
        """Create a secure session token with race condition protection"""
        current_time = time.time()
        
        # Check for race condition - prevent multiple simultaneous logins
        if user_id in self.session_locks:
            time_diff = current_time - self.session_locks[user_id]
            if time_diff < 1.0:  # 1 second lock
                print(f"⚠️ Session creation rate limited for user {user_id}, waiting {1.0 - time_diff:.2f}s")
                # Instead of returning None, wait briefly and try again
                import time as time_module
                time_module.sleep(1.1 - time_diff)
        
        # Set lock for this user
        self.session_locks[user_id] = current_time
        
        # Generate secure session token
        token = secrets.token_urlsafe(32)
        self.session_tokens[token] = user_id
        
        # Only cleanup old sessions if we have too many (keep last 3 sessions)
        user_tokens = [t for t, uid in self.session_tokens.items() if uid == user_id]
        if len(user_tokens) > 3:
            # Remove oldest tokens (keep the 3 most recent)
            tokens_to_remove = user_tokens[:-3]
            for old_token in tokens_to_remove:
                if old_token in self.session_tokens:
                    del self.session_tokens[old_token]
            print(f"🧹 Cleaned up {len(tokens_to_remove)} old sessions for user {user_id}")
        
        print(f"✅ Created secure session token for user {user_id}")
        self._save_sessions()  # Save sessions to persistence
        return token
    
    def get_user_from_cookie(self, token: str) -> Optional[AuthenticatedUser]:
        """Get user from cookie token with additional security checks"""
        if not token or token not in self.session_tokens:
            print(f"🔍 Token validation failed - token {'exists' if token else 'is empty'}, found in sessions: {token in self.session_tokens if token else False}")
            return None
            
        user_id = self.session_tokens[token]
        if user_id not in self.users:
            # Clean up invalid session
            print(f"🔧 Cleaning up invalid session for missing user {user_id}")
            del self.session_tokens[token]
            self.persistence_service.save_sessions(self.session_tokens, self.session_locks)
            return None
            
        user = self.users[user_id]
        
        # Check if user is still valid (not banned, etc.)
        if user.is_banned and user.ban_expires_at and datetime.now() <= user.ban_expires_at:
            print(f"🚫 User {user.username} is currently banned")
            return None
            
        return user
    
    def invalidate_session(self, token: str) -> bool:
        """Invalidate a session token"""
        if token in self.session_tokens:
            user_id = self.session_tokens[token]
            del self.session_tokens[token]
            
            # Clean up lock if exists
            if user_id in self.session_locks:
                del self.session_locks[user_id]
            
            self._save_sessions()  # Save sessions to persistence
            return True
        return False
    
    def _cleanup_user_sessions(self, user_id: str, exclude_token: str = None):
        """Clean up old sessions for a user (keep only the latest)"""
        tokens_to_remove = []
        for token, token_user_id in self.session_tokens.items():
            if token_user_id == user_id and token != exclude_token:
                tokens_to_remove.append(token)
        
        for token in tokens_to_remove:
            del self.session_tokens[token]
        
        if tokens_to_remove:
            self._save_sessions()  # Save sessions to persistence if any were removed
    
    def _save_users(self):
        """Persist all users to DB (batch) and JSON (legacy backup)."""
        async def _save():
            try:
                async for session in get_session():
                    for u in self.users.values():
                        await user_repository.upsert_user(session, u)
                    await session.commit()
            except Exception as e:
                print(f"⚠️ DB save users failed: {e}")
            # Legacy backup JSON (best-effort)
            try:
                persistence_service.save_users(self.users)
            except Exception as e:
                print(f"⚠️ JSON backup save failed: {e}")
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(_save())
            else:
                loop.run_until_complete(_save())
        except RuntimeError:
            asyncio.run(_save())

    def _save_user(self, username: str):
        """Persist a single user (optimized for frequent updates)."""
        user = self.users.get(username)
        if not user:
            return
        async def _save_one():
            try:
                async for session in get_session():
                    await user_repository.upsert_user(session, user)
                    await session.commit()
            except Exception as e:
                print(f"⚠️ DB save user {username} failed: {e}")
            try:
                persistence_service.save_users(self.users)
            except Exception:
                pass
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(_save_one())
            else:
                loop.run_until_complete(_save_one())
        except RuntimeError:
            asyncio.run(_save_one())
    
    def _save_sessions(self):
        """Save sessions to persistence"""
        persistence_service.save_sessions(self.session_tokens, self.session_locks)
    
    def update_user_stats(self, user_id: str, pixels_placed: int = 0, messages_sent: int = 0):
        """Update user statistics"""
        if user_id in self.users:
            user = self.users[user_id]
            if pixels_placed > 0:
                user.total_pixels_placed += pixels_placed
                user.last_pixel_placed_at = datetime.now()
                # Award experience points
                user.experience_points += pixels_placed * 10
                # Redis counter
                try:
                    if redis_client:
                        redis_client.hincrby('counters:pixels', user_id, pixels_placed)
                except Exception:
                    pass
            
            if messages_sent > 0:
                user.total_messages_sent += messages_sent
                user.last_message_sent_at = datetime.now()
                # Award experience points
                user.experience_points += messages_sent * 5
                try:
                    if redis_client:
                        redis_client.hincrby('counters:messages', user_id, messages_sent)
                except Exception:
                    pass
            
            # Level up system
            required_xp = user.user_level * 1000
            if user.experience_points >= required_xp:
                user.user_level += 1
                # Upgrade pixel bag size as reward (no hardcoded limit)
                user.max_pixel_bag_size += 5
                user.pixel_bag_size = user.max_pixel_bag_size
                print(f"LEVEL UP: User {user.username} leveled up – new max bag: {user.max_pixel_bag_size}")
            
            self._save_user(user_id)
            # After saving, evaluate achievements server-side (only for pixel/chat based)
            try:
                from app.services.achievement_service import achievement_service
                newly = achievement_service.evaluate_for_user(user_id)
                if newly:
                    print(f"🏅 User {user_id} unlocked: {newly}")
            except Exception as e:
                print(f"⚠️ Achievement evaluation failed: {e}")

    # ==================== ACHIEVEMENTS ====================
    def unlock_achievement(self, username: str, achievement_id: str) -> bool:
        """Unlock a single achievement for a user (idempotent)."""
        user = self.get_user_by_username(username)
        if not user:
            return False
        if achievement_id not in user.achievements:
            user.achievements.append(achievement_id)
            self._save_user(username)
            print(f"ACHIEVEMENT: unlocked for {username}: {achievement_id}")
            return True
        return False

    def set_achievements(self, username: str, achievement_ids: list[str]) -> bool:
        """Replace user's achievements with provided list (used for sync)."""
        user = self.get_user_by_username(username)
        if not user:
            return False
        # Ensure uniqueness
        user.achievements = list(dict.fromkeys(achievement_ids))
        self._save_users()
        return True

    def get_user_achievements(self, username: str) -> list[str]:
        user = self.get_user_by_username(username)
        return user.achievements[:] if user else []

    def get_global_achievement_distribution(self) -> dict:
        """Return {achievement_id: {count: int, percentage: float}}"""
        distribution: dict[str, dict] = {}
        total_users = max(1, len(self.users))
        for user in self.users.values():
            for ach in getattr(user, 'achievements', []) or []:
                entry = distribution.setdefault(ach, {"count": 0})
                entry["count"] += 1
        # Compute percentages
        for ach_id, data in distribution.items():
            data["percentage"] = round((data["count"] / total_users) * 100, 2)
        return {"total_users": total_users, "achievements": distribution}
    
    def get_user_by_id(self, user_id: str) -> Optional[AuthenticatedUser]:
        """Get user by ID"""
        return self.users.get(user_id)
    
    def get_user_by_username(self, username: str) -> Optional[AuthenticatedUser]:
        """Get user by username (alias for get_user_by_id since username is the ID)"""
        return self.users.get(username)
    
    def refill_user_pixels(self, username: str) -> int:
        """Refill user's pixel bag based on time passed - DATABASE VERSION"""
        user = self.get_user_by_username(username)
        if not user:
            return 0
        
        if not user.last_pixel_placed_at:
            # If never placed a pixel, start from now
            user.last_pixel_placed_at = datetime.now()
            return 0
        
        current_time = datetime.now()
        time_passed = (current_time - user.last_pixel_placed_at).total_seconds()
        pixels_to_add = int(time_passed // self.settings.PIXEL_REFILL_RATE)
        
        if pixels_to_add > 0:
            old_count = user.pixel_bag_size
            user.pixel_bag_size = min(user.max_pixel_bag_size, user.pixel_bag_size + pixels_to_add)
            
            # Update refill timestamp
            user.last_pixel_placed_at = current_time
            
            # Save to database
            self._save_user(username)
            
            pixels_added = user.pixel_bag_size - old_count
            if pixels_added > 0:
                print(f"🔋 Refilled {username}: +{pixels_added} pixels ({user.pixel_bag_size}/{user.max_pixel_bag_size})")
            
            return pixels_added
        return 0
    
    def update_user_field(self, username: str, field: str, value: str) -> bool:
        """Update a specific field for a user (admin only)"""
        try:
            user = self.get_user_by_username(username)
            if not user:
                print(f"❌ User {username} not found for update")
                return False
            
            # Convert value to appropriate type based on field
            converted_value = value
            if field in ['pixel_bag_size', 'max_pixel_bag_size', 'experience_points', 'user_level', 'total_pixels_placed']:
                converted_value = int(value)
            elif field in ['display_name', 'chat_color']:
                converted_value = str(value)
            
            # Update the field
            if hasattr(user, field):
                setattr(user, field, converted_value)
                print(f"✅ Updated {username}.{field} = {converted_value}")
                
                # Special handling for pixel_bag_size: also update active WebSocket session
                if field == 'pixel_bag_size':
                    from app.services.region_manager import region_manager
                    ws_user = region_manager.user_service.get_user(username)
                    if ws_user:
                        ws_user.pixel_bag = converted_value
                        print(f"✅ Synced WebSocket user {username} pixel_bag to {converted_value}")
                
                # Special handling for max_pixel_bag_size: ensure current bag doesn't exceed new max
                if field == 'max_pixel_bag_size':
                    # Also cap current pixel_bag_size if it exceeds new max
                    if user.pixel_bag_size > converted_value:
                        user.pixel_bag_size = converted_value
                        print(f"✅ Capped {username} pixel_bag_size to new max: {converted_value}")
                    
                    # Update WebSocket session if active
                    from app.services.region_manager import region_manager
                    ws_user = region_manager.user_service.get_user(username)
                    if ws_user and ws_user.pixel_bag > converted_value:
                        ws_user.pixel_bag = converted_value
                        print(f"✅ Synced WebSocket user {username} pixel_bag to new max: {converted_value}")
                
                # Save to persistence
                self._save_user(username)
                return True
            else:
                print(f"❌ Field {field} not found on user model")
                return False
                
        except Exception as e:
            print(f"❌ Error updating user field: {e}")
            return False


# Global auth service instance
auth_service = AuthService()

# Background flush task for Redis counters -> DB
async def _flush_counters_loop():
    if not redis_client:
        return
    while True:
        try:
            await asyncio.sleep(5)
            pixel_map = await redis_client.hgetall('counters:pixels') if redis_client else {}
            msg_map = await redis_client.hgetall('counters:messages') if redis_client else {}
            if not pixel_map and not msg_map:
                continue
            async for session in get_session():
                for uid, inc in pixel_map.items():
                    u = auth_service.get_user_by_username(uid)
                    if u:
                        # Already incremented locally; just persist
                        await user_repository.upsert_user(session, u)
                for uid, inc in msg_map.items():
                    u = auth_service.get_user_by_username(uid)
                    if u:
                        await user_repository.upsert_user(session, u)
                await session.commit()
            # Reset counters after flush
            pipe = redis_client.pipeline(True)
            pipe.delete('counters:pixels')
            pipe.delete('counters:messages')
            await pipe.execute()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"⚠️ Counter flush error: {e}")

def _schedule_counter_flush():
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(_flush_counters_loop())
        else:
            # Defer until loop actually starts: use a short-lived background thread trigger
            def _delayed():
                asyncio.run(_flush_counters_loop())
            import threading
            threading.Thread(target=_delayed, daemon=True).start()
    except RuntimeError:
        pass

_schedule_counter_flush()
