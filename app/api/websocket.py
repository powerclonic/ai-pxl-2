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
        
        # Perform immediate refill tick so client starts with freshest bag
        auth_service.refill_user_pixels(authenticated_user.username)
        auth_refreshed = auth_service.get_user_by_username(authenticated_user.username)
        # Send authentication success with bag snapshot
        await websocket.send_text(json.dumps({
            "type": "auth_success",
            "user": {
                "id": auth_refreshed.id,
                "username": auth_refreshed.username,
                "role": auth_refreshed.role.value,
                "coins": getattr(auth_refreshed, 'coins', 0),
                "experience_points": getattr(auth_refreshed, 'experience_points', 0),
                "user_level": getattr(auth_refreshed, 'user_level', 1),
                "xp_to_next": getattr(auth_refreshed, 'xp_to_next_cache', 0),
                "pixel_bag_size": auth_refreshed.pixel_bag_size,
                "max_pixel_bag_size": auth_refreshed.max_pixel_bag_size,
                "next_pixel_in": auth_service.get_next_pixel_in(auth_refreshed.username),
                "full_refill_eta": auth_service.get_full_refill_eta(auth_refreshed.username)
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
                        "pixel_bag_size": updated_user.pixel_bag_size,
                        "max_pixel_bag_size": updated_user.max_pixel_bag_size,
                        "next_pixel_in": auth_service.get_next_pixel_in(updated_user.username),
                        "full_refill_eta": auth_service.get_full_refill_eta(updated_user.username),
                        "coins": getattr(updated_user, 'coins', 0),
                        "user_level": getattr(updated_user, 'user_level', 1),
                        "experience_points": getattr(updated_user, 'experience_points', 0),
                        "xp_to_next": getattr(updated_user, 'xp_to_next_cache', 0)
                    }))
                    print(f"📦 Sent pixel bag update from DB: {updated_user.pixel_bag_size}/{updated_user.max_pixel_bag_size}")
            
            elif message_type == MessageType.BULK_PIXEL_PLACE.value:
                # Handle bulk pixel placement with dynamic refill awareness
                pixels = message.get("pixels", [])
                if not pixels:
                    continue

                print(f"🚀 DEBUG: Bulk placing {len(pixels)} pixels for user: {authenticated_user.username}")

                # Always refill before bulk attempt to capture recent time-based gains
                auth_service.refill_user_pixels(authenticated_user.username)
                current_user = auth_service.get_user_by_username(authenticated_user.username)
                if not current_user:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "User not found"
                    }))
                    continue

                starting_available = current_user.pixel_bag_size
                print(f"PIXEL BAG (start bulk): {starting_available}/{current_user.max_pixel_bag_size}")

                successful_placements = 0
                attempted = 0
                batch_updates = []  # accumulate pixel updates for single broadcast per region set
                BULK_PERSIST_INTERVAL = 25  # (legacy) interval not used for direct saves now
                MAX_BULK_DURATION_MS = 3000  # safety cutoff
                start_ms = time.time() * 1000
                # Process pixels one-by-one so mid-bulk refills (from time) can be applied.
                for pixel in pixels:
                    # Duration guard
                    if (time.time() * 1000 - start_ms) > MAX_BULK_DURATION_MS:
                        print("⏱️ Bulk duration limit reached, stopping early")
                        break
                    # Refill opportunistically every N pixels (e.g., each loop; cost low) to capture time passage
                    auth_service.refill_user_pixels(authenticated_user.username)
                    current_user = auth_service.get_user_by_username(authenticated_user.username)
                    if current_user.pixel_bag_size <= 0:
                        break  # Can't place more
                    # Consume first (atomic style) then attempt placement
                    current_user.pixel_bag_size -= 1
                    consume_time = datetime.now()
                    attempted += 1
                    placed_ok = False
                    try:
                        placed_ok = await region_manager.canvas_service.place_pixel(pixel["x"], pixel["y"], pixel["color"], authenticated_user.username)
                    except Exception as e:
                        print(f"❌ Error placing bulk pixel at ({pixel['x']}, {pixel['y']}): {e}")
                    if placed_ok:
                        successful_placements += 1
                        current_user.total_pixels_placed += 1
                        current_user.last_pixel_placed_at = consume_time
                        # Economy rewards per pixel (match single placement logic)
                        try:
                            from app.services.xp_service import xp_service
                            from datetime import datetime as _dt
                            WINDOW = 60
                            BASE_COIN = 1
                            BASE_XP = 1
                            SOFT_CAP = 120
                            HARD_CAP = 400
                            FLOOR = 0.25
                            now_dt = _dt.now()
                            if not current_user.reward_window_start or (now_dt - current_user.reward_window_start).total_seconds() > WINDOW:
                                current_user.reward_window_start = now_dt
                                current_user.reward_actions_in_window = 0
                            current_user.reward_actions_in_window += 1
                            actions = current_user.reward_actions_in_window
                            if actions <= SOFT_CAP:
                                scale = 1.0
                            elif actions <= HARD_CAP:
                                frac = (actions - SOFT_CAP) / (HARD_CAP - SOFT_CAP)
                                scale = 1.0 - frac * (1.0 - FLOOR)
                            else:
                                scale = FLOOR
                            coin_gain = 1 if scale >= 0.25 else 0
                            xp_gain = 1 if scale >= 0.10 else 0
                            reward_changed = False
                            if coin_gain > 0:
                                current_user.coins = getattr(current_user, 'coins', 0) + coin_gain
                                reward_changed = True
                            if xp_gain > 0:
                                xp_service.add_xp(authenticated_user.username, xp_gain)
                                reward_changed = True
                            # Optional broadcast of updated reward scaling snapshot to initiator
                            if reward_changed:
                                try:
                                    snap = auth_service.get_reward_scaling_snapshot(authenticated_user.username)
                                    await websocket.send_text(json.dumps({"type": "reward_scale_update", **snap}))
                                except Exception as e:
                                    print(f"⚠️ Failed sending reward_scale_update: {e}")
                        except Exception as e:
                            print(f"⚠️ Bulk reward grant failed: {e}")
                        # Forward potential effect metadata if provided in request (client may supply effect id)
                        batch_updates.append({
                            "x": pixel["x"],
                            "y": pixel["y"],
                            "color": pixel["color"],
                            "effect": pixel.get("effect"),
                            "user_id": authenticated_user.username,
                            "timestamp": time.time()
                        })
                    else:
                        # Rollback pixel if placement failed
                        current_user.pixel_bag_size += 1
                    # Instead of immediate save, enqueue dirty user for batched persistence
                    auth_service.enqueue_dirty(authenticated_user.username)

                # Final flush of dirty user state after bulk completes
                auth_service.enqueue_dirty(authenticated_user.username)

                ending_available = current_user.pixel_bag_size
                print(f"✅ Bulk done. Placed {successful_placements}/{attempted} (requested {len(pixels)}). Bag now {ending_available}")

                # Broadcast batch updates grouped by regions (single message per region set)
                if batch_updates:
                    # Determine all distinct regions touched
                    regions_map = {}
                    for upd in batch_updates:
                        region_coords = region_manager.canvas_service.get_region_coords(upd["x"], upd["y"])
                        regions_map.setdefault(region_coords, []).append(upd)
                    for (rx, ry), updates in regions_map.items():
                        await region_manager.broadcast_to_region(rx, ry, {
                            "type": MessageType.PIXEL_BATCH_UPDATE.value,
                            "updates": updates
                        })

                # Also send to the initiating client their bag + completion summary
                await websocket.send_text(json.dumps({
                    "type": "pixel_bag_update",
                    "pixel_bag_size": ending_available,
                    "max_pixel_bag_size": current_user.max_pixel_bag_size,
                    "next_pixel_in": auth_service.get_next_pixel_in(authenticated_user.username),
                    "full_refill_eta": auth_service.get_full_refill_eta(authenticated_user.username),
                    "coins": getattr(current_user, 'coins', 0),
                    "experience_points": getattr(current_user, 'experience_points', 0),
                    "user_level": getattr(current_user, 'user_level', 1),
                    "xp_to_next": getattr(current_user, 'xp_to_next_cache', 0)
                }))
                await websocket.send_text(json.dumps({
                    "type": "bulk_complete",
                    "placed": successful_placements,
                    "total": len(pixels),
                    "requested": len(pixels),
                    "available_at_start": starting_available,
                    "attempted": attempted,
                    "remaining": ending_available,
                    "duration_ms": int(time.time()*1000 - start_ms),
                    "coins": getattr(current_user, 'coins', 0),
                    "experience_points": getattr(current_user, 'experience_points', 0),
                    "user_level": getattr(current_user, 'user_level', 1),
                    "xp_to_next": getattr(current_user, 'xp_to_next_cache', 0)
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
