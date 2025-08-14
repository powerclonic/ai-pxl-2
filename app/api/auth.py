"""
Authentication API routes with cookie support.
"""
from fastapi import APIRouter, HTTPException, status, Request, Response, Depends, Form
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from app.services.auth_service import auth_service
from app.models.models import AuthenticatedUser

# Request/Response models
class LoginRequest(BaseModel):
    username: str
    password: str
    captcha_answer: Optional[str] = None

class RegisterRequest(BaseModel):
    username: str
    password: str

class LoginResponse(BaseModel):
    success: bool
    message: str
    user: Optional[dict] = None

class UserInfoResponse(BaseModel):
    id: str
    username: str
    role: str
    total_pixels_placed: int
    total_messages_sent: int
    user_level: int
    experience_points: int
    pixel_bag_size: int
    max_pixel_bag_size: int
    created_at: str
    last_login: Optional[str] = None

class BanRequest(BaseModel):
    username: str
    reason: str
    temporary: bool = False

class UpdateUserRequest(BaseModel):
    username: str
    field: str
    value: str  # Changed to str to handle both numbers and strings

# Cookie settings
COOKIE_NAME = "pixel_canvas_session"
COOKIE_MAX_AGE = 365 * 24 * 60 * 60  # 1 year in seconds (indefinite)

def get_current_user_from_cookie(request: Request) -> Optional[AuthenticatedUser]:
    """Get current user from cookie"""
    token = request.cookies.get(COOKIE_NAME)
    print(f"🍪 Cookie '{COOKIE_NAME}' value: {token[:20]}..." if token else f"🍪 Cookie '{COOKIE_NAME}' not found")
    
    if not token:
        return None
        
    # Try to get user from auth service
    user = auth_service.get_user_from_cookie(token)
    if user:
        print(f"✅ Found user {user.username} from cookie")
    else:
        print(f"❌ No user found for token")
        
    return user

def require_auth(request: Request) -> AuthenticatedUser:
    """Dependency that requires authentication"""
    user = get_current_user_from_cookie(request)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required"
        )
    return user

def require_admin(request: Request) -> AuthenticatedUser:
    """Dependency that requires admin role"""
    user = require_auth(request)
    if not auth_service.is_admin(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    return user

router = APIRouter(prefix="/auth", tags=["authentication"])

@router.post("/login", response_model=LoginResponse)
async def login(login_data: LoginRequest, response: Response):
    """Login user with cookies"""
    success, message, token = auth_service.login_user(
        login_data.username, 
        login_data.password, 
        login_data.captcha_answer
    )
    
    if success and token:
        # Set persistent cookie (indefinite)
        response.set_cookie(
            key=COOKIE_NAME,
            value=token,
            max_age=COOKIE_MAX_AGE,
            httponly=True,
            secure=False,  # Set to True in production with HTTPS
            samesite="lax",
            path="/"  # Available for entire domain
        )
        
        user = auth_service.get_user_from_cookie(token)
        user_data = {
            "id": user.id,
            "username": user.username,
            "role": user.role.value,
            "total_pixels_placed": user.total_pixels_placed,
            "total_messages_sent": user.total_messages_sent,
            "user_level": user.user_level,
            "experience_points": user.experience_points,
            "pixel_bag_size": user.pixel_bag_size,
            "max_pixel_bag_size": user.max_pixel_bag_size
        }
        
        return LoginResponse(success=True, message=message, user=user_data)
    else:
        return LoginResponse(success=False, message=message)

@router.post("/register", response_model=LoginResponse)
async def register(register_data: RegisterRequest, response: Response):
    """Register new user"""
    success, message = auth_service.register_user(
        register_data.username, 
        register_data.password
    )
    
    if success:
        # Auto-login after registration
        login_success, login_message, token = auth_service.login_user(
            register_data.username,
            register_data.password
        )
        
        if login_success and token:
            response.set_cookie(
                key=COOKIE_NAME,
                value=token,
                max_age=COOKIE_MAX_AGE,
                httponly=True,
                secure=False,
                samesite="lax"
            )
            
            user = auth_service.get_user_from_cookie(token)
            user_data = {
                "id": user.id,
                "username": user.username,
                "role": user.role.value,
                "total_pixels_placed": user.total_pixels_placed,
                "total_messages_sent": user.total_messages_sent,
                "user_level": user.user_level,
                "experience_points": user.experience_points,
                "pixel_bag_size": user.pixel_bag_size,
                "max_pixel_bag_size": user.max_pixel_bag_size
            }
            
            return LoginResponse(success=True, message="Registration and login successful", user=user_data)
    
    return LoginResponse(success=False, message=message)

@router.post("/logout")
async def logout(request: Request, response: Response):
    """Logout user"""
    token = request.cookies.get(COOKIE_NAME)
    if token:
        auth_service.invalidate_session(token)
    
    response.delete_cookie(key=COOKIE_NAME)
    return {"success": True, "message": "Logged out successfully"}

@router.get("/me", response_model=UserInfoResponse)
async def get_current_user_info(user: AuthenticatedUser = Depends(require_auth)):
    """Get current user information"""
    return UserInfoResponse(
        id=user.id,
        username=user.username,
        role=user.role.value,
        total_pixels_placed=user.total_pixels_placed,
        total_messages_sent=user.total_messages_sent,
        user_level=user.user_level,
        experience_points=user.experience_points,
        pixel_bag_size=user.pixel_bag_size,
        max_pixel_bag_size=user.max_pixel_bag_size,
        created_at=user.created_at.isoformat(),
        last_login=user.last_login.isoformat() if user.last_login else None
    )

@router.get("/pixel-status")
async def get_pixel_status(user: AuthenticatedUser = Depends(require_auth)):
    """Get current pixel bag status from database (with auto-refill)"""
    # Refill pixels first
    auth_service.refill_user_pixels(user.username)
    
    # Get updated user data
    updated_user = auth_service.get_user_by_username(user.username)
    
    return {
        "pixel_bag_size": updated_user.pixel_bag_size,
        "max_pixel_bag_size": updated_user.max_pixel_bag_size,
        "timestamp": datetime.now().isoformat()
    }

@router.get("/captcha/{user_id}")
async def get_captcha(user_id: str):
    """Get CAPTCHA challenge for user"""
    challenge = auth_service.generate_captcha_challenge(user_id)
    return {
        "challenge_id": challenge.challenge_id,
        "question": challenge.question
    }

@router.get("/check")
async def check_auth(request: Request):
    """Check if user is authenticated"""
    print(f"🔍 /auth/check called")
    print(f"🍪 All cookies: {dict(request.cookies)}")
    
    user = get_current_user_from_cookie(request)
    if user:
        # Check if we already have a WebSocket token for this user
        existing_tokens = [token for token, uid in auth_service.session_tokens.items() if uid == user.id]
        
        if existing_tokens:
            # Use existing token instead of creating a new one
            ws_token = existing_tokens[0]
            print(f"✅ User authenticated: {user.username}, using existing WS token")
        else:
            # Generate a temporary WebSocket token for this session
            ws_token = auth_service.create_secure_session(user.id)
            print(f"✅ User authenticated: {user.username}, generating WS token")
        
        return {
            "authenticated": True,
            "user": {
                "id": user.id,
                "username": user.username,
                "role": user.role.value,
                "pixel_bag_size": user.pixel_bag_size,
                "max_pixel_bag_size": user.max_pixel_bag_size
            },
            "ws_token": ws_token  # Token for WebSocket auth
        }
    
    print(f"❌ User not authenticated")
    return {"authenticated": False}

# Admin routes
@router.get("/admin/users")
async def get_all_users(admin: AuthenticatedUser = Depends(require_admin)):
    """Get all users (admin only)"""
    users = auth_service.get_all_users()
    return [
        {
            "id": user.id,
            "username": user.username,
            "role": user.role.value,
            "total_pixels_placed": user.total_pixels_placed,
            "total_messages_sent": user.total_messages_sent,
            "user_level": user.user_level,
            "experience_points": user.experience_points,
            "is_banned": user.is_banned,
            "ban_reason": user.ban_reason,
            "created_at": user.created_at.isoformat(),
            "last_login": user.last_login.isoformat() if user.last_login else None
        }
        for user in users
    ]

@router.post("/admin/ban")
async def ban_user(
    request: BanRequest,
    admin: AuthenticatedUser = Depends(require_admin)
):
    """Ban a user (admin only)"""
    success = auth_service.ban_user(request.username, request.reason, request.temporary)
    if success:
        return {"success": True, "message": f"User {request.username} banned successfully"}
    return {"success": False, "message": "Failed to ban user"}

@router.post("/admin/unban/{username}")
async def unban_user(username: str, admin: AuthenticatedUser = Depends(require_admin)):
    """Unban a user (admin only)"""
    success = auth_service.unban_user(username)
    if success:
        return {"success": True, "message": f"User {username} unbanned successfully"}
    return {"success": False, "message": "Failed to unban user"}

@router.post("/admin/update-user")
async def update_user_data(request: UpdateUserRequest, admin: AuthenticatedUser = Depends(require_admin)):
    """Update user data (admin only)"""
    # Validate field name for security
    allowed_fields = ['pixel_bag_size', 'max_pixel_bag_size', 'experience_points', 'user_level', 'display_name', 'chat_color']
    if request.field not in allowed_fields:
        raise HTTPException(status_code=400, detail="Invalid field")
    
    success = auth_service.update_user_field(request.username, request.field, request.value)
    if success:
        return {"success": True, "message": f"Updated {request.username} {request.field} to {request.value}"}
    return {"success": False, "message": "Failed to update user data"}
