"""
WebSocket endpoints for real-time communication.
"""
import json
import time
from datetime import datetime
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
            
            elif message_type == MessageType.BULK_PIXEL_PLACE.value:
                # Handle bulk pixel placement
                pixels = message.get("pixels", [])
                if not pixels:
                    continue
                
                print(f"🚀 DEBUG: Bulk placing {len(pixels)} pixels for user: {authenticated_user.username}")
                
                # Get current user state
                current_user = auth_service.get_user_by_username(authenticated_user.username)
                if not current_user:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "User not found"
                    }))
                    continue
                
                available_pixels = current_user.pixel_bag_size
                print(f"💰 User has {available_pixels} pixels available for {len(pixels)} requested")
                
                # Process as many pixels as possible (up to available amount)
                pixels_to_process = pixels[:available_pixels] if len(pixels) > available_pixels else pixels
                print(f"📦 Processing {len(pixels_to_process)} pixels (requested: {len(pixels)}, available: {available_pixels})")
                
                # CONSUME ALL PIXELS AT ONCE before placing any
                if len(pixels_to_process) > 0:
                    current_user.pixel_bag_size -= len(pixels_to_process)
                    current_user.total_pixels_placed += len(pixels_to_process)
                    current_user.last_pixel_placed_at = datetime.now()
                    auth_service._save_users()
                    print(f"💰 PRE-CONSUMED {len(pixels_to_process)} pixels. Bag now: {current_user.pixel_bag_size}")
                
                # Place all processable pixels (without individual pixel bag checks)
                successful_placements = 0
                for pixel in pixels_to_process:
                    try:
                        # Place directly on canvas without pixel bag validation
                        if await region_manager.canvas_service.place_pixel(pixel["x"], pixel["y"], pixel["color"], authenticated_user.username):
                            successful_placements += 1
                            
                            # Broadcast pixel update manually
                            region_coords = region_manager.canvas_service.get_region_coords(pixel["x"], pixel["y"])
                            await region_manager.broadcast_to_region(region_coords[0], region_coords[1], {
                                "type": MessageType.PIXEL_UPDATE.value,
                                "x": pixel["x"],
                                "y": pixel["y"],
                                "color": pixel["color"],
                                "user_id": authenticated_user.username,
                                "timestamp": time.time()
                            })
                    except Exception as e:
                        print(f"❌ Error placing bulk pixel at ({pixel['x']}, {pixel['y']}): {e}")
                
                print(f"✅ Successfully placed {successful_placements}/{len(pixels_to_process)} bulk pixels")
                
                # Send updated pixel bag
                updated_user = auth_service.get_user_by_username(authenticated_user.username)
                if updated_user:
                    await websocket.send_text(json.dumps({
                        "type": "pixel_bag_update",
                        "pixel_bag_size": updated_user.pixel_bag_size,
                        "max_pixel_bag_size": updated_user.max_pixel_bag_size
                    }))
                    
                    # Send bulk completion notification with more info
                    await websocket.send_text(json.dumps({
                        "type": "bulk_complete",
                        "placed": successful_placements,
                        "total": len(pixels),
                        "requested": len(pixels),
                        "available_at_start": available_pixels,
                        "processed": len(pixels_to_process)
                    }))
            
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
                # User moved to a different region (legacy support)
                await region_manager.move_user_to_region(
                    authenticated_user.username,
                    message["region_x"],
                    message["region_y"]
                )
            
            elif message_type == "viewport_regions":
                # User's viewport includes multiple regions - new multi-region system
                visible_regions = []
                for region_data in message.get("regions", []):
                    visible_regions.append((region_data["x"], region_data["y"]))
                
                await region_manager.update_user_regions(
                    authenticated_user.username,
                    visible_regions
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
