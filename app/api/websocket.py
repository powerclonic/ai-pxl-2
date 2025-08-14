"""
WebSocket endpoints for real-time communication.
"""
import json
from fastapi import WebSocket, WebSocketDisconnect
from app.models import MessageType
from app.services import RegionManager
from app.services.auth_service import auth_service
from app.core.config import settings

async def websocket_endpoint(websocket: WebSocket, user_id: str, region_manager: RegionManager):
    """Handle WebSocket connections for real-time communication"""
    # Authenticate user on WebSocket connection
    authenticated_user = None
    
    try:
        # Accept connection first
        await websocket.accept()
        
        # Wait for authentication message
        data = await websocket.receive_text()
        auth_message = json.loads(data)
        
        if auth_message.get("type") != "auth" or "token" not in auth_message:
            await websocket.send_text(json.dumps({
                "type": "auth_error",
                "message": "Authentication required"
            }))
            await websocket.close(code=1008, reason="Authentication required")
            return
        
        # Verify token
        authenticated_user = auth_service.get_current_user(auth_message["token"])
        if not authenticated_user:
            await websocket.send_text(json.dumps({
                "type": "auth_error", 
                "message": "Invalid authentication token"
            }))
            await websocket.close(code=1008, reason="Invalid token")
            return
        
        # Check if user is banned
        if authenticated_user.is_banned:
            ban_message = "Account is banned"
            if authenticated_user.ban_reason:
                ban_message += f": {authenticated_user.ban_reason}"
            
            await websocket.send_text(json.dumps({
                "type": "auth_error",
                "message": ban_message
            }))
            await websocket.close(code=1008, reason="User banned")
            return
        
        # Send authentication success
        await websocket.send_text(json.dumps({
            "type": "auth_success",
            "user": {
                "id": authenticated_user.id,
                "username": authenticated_user.username,
                "role": authenticated_user.role.value
            }
        }))
        
        # Connect user after successful authentication
        await region_manager.connect_user(websocket, authenticated_user.username)
        
        while True:
            # Receive message from client
            data = await websocket.receive_text()
            message = json.loads(data)
            
            message_type = message.get("type")
            print(f"DEBUG: Received message type: {message_type} from user: {authenticated_user.username}")
            
            if message_type == MessageType.PIXEL_PLACE.value:
                # Check rate limiting before placing pixel
                if not auth_service.check_rate_limit(authenticated_user.username):
                    await websocket.send_text(json.dumps({
                        "type": "rate_limit",
                        "message": "Too many actions. Please slow down."
                    }))
                    continue
                
                print(f"DEBUG: Placing pixel at ({message['x']}, {message['y']}) with color {message['color']}")
                result = await region_manager.place_pixel(
                    authenticated_user.username, 
                    message["x"], 
                    message["y"], 
                    message["color"]
                )
                print(f"DEBUG: Pixel placement result: {result}")
                
                # Get updated pixel bag from database (single source of truth)
                updated_user = auth_service.get_user_by_username(authenticated_user.username)
                if updated_user:
                    await websocket.send_text(json.dumps({
                        "type": "pixel_bag_update",
                        "pixel_bag_size": updated_user.pixel_bag_size,  # From database
                        "max_pixel_bag_size": updated_user.max_pixel_bag_size  # From database
                    }))
                    print(f"📦 Sent pixel bag update from DB: {updated_user.pixel_bag_size}/{updated_user.max_pixel_bag_size}")
            
            elif message_type == MessageType.CHAT_MESSAGE.value:
                # Check rate limiting for chat
                if not auth_service.check_rate_limit(authenticated_user.username):
                    await websocket.send_text(json.dumps({
                        "type": "rate_limit",
                        "message": "Too many messages. Please slow down."
                    }))
                    continue
                
                await region_manager.send_chat_message(
                    authenticated_user.username, 
                    message["message"]
                )
            
            elif message_type == MessageType.USER_POSITION.value:
                # User moved to a different region
                await region_manager.move_user_to_region(
                    authenticated_user.username,
                    message["region_x"],
                    message["region_y"]
                )
            
            elif message_type == "ping":
                # Handle ping request
                await websocket.send_text(json.dumps({
                    "type": "pong",
                    "timestamp": message["timestamp"]
                }))
            
    except WebSocketDisconnect:
        if authenticated_user:
            await region_manager.disconnect_user(authenticated_user.username)
    except Exception as e:
        print(f"WebSocket error: {e}")
        if authenticated_user:
            await region_manager.disconnect_user(authenticated_user.username)
