require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const http = require('http'); 

// Authentication and Session management
const session = require('express-session');

// Real-time communication (WebSockets)
const { Server } = require('socket.io');

// Our Mongoose models
const User = require('./models/User');
const FriendRequest = require('./models/FriendRequest');
const DirectMessage = require('./models/DirectMessage'); // <--- NEW IMPORT

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app); // Create an HTTP server for Express and Socket.IO
const PORT = process.env.PORT || 3000; // Use port from .env or default to 3000

// --- Mongoose Connection ---
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully!'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- Session Middleware Configuration ---
const sharedSession = session({
    secret: process.env.SESSION_SECRET,
    resave: false, // Don't save session if unmodified
    saveUninitialized: false, // Don't create session until something stored
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 24 hours (milliseconds)
        // IMPORTANT: If you are running on http://localhost, this MUST be commented out.
        // Uncomment 'secure: true' ONLY when deploying to a live server with HTTPS.
        // secure: true,
        httpOnly: true // Recommended: Prevents client-side JavaScript from accessing the cookie
    }
});
app.use(sharedSession); // Use session middleware for Express routes

// --- Express Middleware ---
app.use(express.json()); // For parsing application/json bodies
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded bodies

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Socket.IO Setup ---
const io = new Server(server); // Attach Socket.IO to the HTTP server

// Share the session middleware with Socket.IO
// This allows Socket.IO to access session data from the HTTP request
io.engine.use(sharedSession);

// --- In-memory Stores for Chat State ---
// For a real app, public messages would be in a persistent database
const publicMessages = []; // Stores objects like { user: 'username', text: 'message', timestamp: 'time' }

// Maps userId to an array of socket IDs (a user might have multiple tabs open)
const onlineUsers = new Map(); // userId (ObjectId) -> Set<socket.id>
// Maps socket.id to userId (for quick lookup on disconnect)
const socketIdToUserId = new Map();

// Stores typing status: Map<username, Set<recipientUsername>>
// If recipientUsername is null, it means public chat typing.
const typingUsers = new Map(); // username -> Set<typing_to_username | null>

// --- Helper functions for Socket.IO broadcasts ---

// UPDATED: Broadcasts updated online users (including their usernames)
async function broadcastOnlineUsers() {
    try {
        const onlineUserIds = Array.from(onlineUsers.keys());
        if (onlineUserIds.length === 0) {
            io.emit('online_users_list', []);
            console.log('Server: broadcastOnlineUsers - No users online. Broadcasted empty list.');
            return;
        }

        // Fetch all online usernames in a single database query
        const users = await User.find({ _id: { $in: onlineUserIds } }).select('username _id');
        const onlineUsernames = users.map(user => user.username);

        io.emit('online_users_list', onlineUsernames);
        console.log('Server: broadcastOnlineUsers - Online users broadcasted:', onlineUsernames);

        // Optional: Clean up onlineUsers map if any userId was not found in DB (e.g., deleted user)
        const foundUserIds = new Set(users.map(user => user._id.toString()));
        onlineUserIds.forEach(userId => { // userId here is an ObjectId from Map.keys()
            if (!foundUserIds.has(userId.toString())) { // Convert ObjectId to string for comparison with Set of strings
                console.warn(`Server: broadcastOnlineUsers - Cleaning up stale userId ${userId} from onlineUsers map (not found in DB).`);
                onlineUsers.delete(userId);
            }
        });

    } catch (error) {
        console.error('Server: broadcastOnlineUsers - Error broadcasting online users:', error);
        // You might want to emit an error to clients or retry here
    }
}


// Broadcasts typing status to all clients
function broadcastTypingStatus() {
    const typingMapForClient = {};
    typingUsers.forEach((recipientsSet, username) => {
        typingMapForClient[username] = Array.from(recipientsSet);
    });
    io.emit('typing status', typingMapForClient);
    console.log('Server: broadcastTypingStatus - Typing status broadcasted:', typingMapForClient);
}

// Emits friend list and pending requests to a specific user (all their connected sockets)
async function emitFriendAndRequestData(userId) {
    console.log(`Server: emitFriendAndRequestData - Fetching data for userId: ${userId}`);
    try {
        const user = await User.findById(userId)
            .populate('friends', 'username') // Populate friends to get usernames
            .select('username friends');

        if (!user) {
            console.warn(`Server: emitFriendAndRequestData - User not found for ID: ${userId}`);
            return;
        }

        // Get outgoing pending requests
        const outgoingRequests = await FriendRequest.find({ sender: userId, status: 'pending' })
            .populate('receiver', 'username');

        // Get incoming pending requests
        const incomingRequests = await FriendRequest.find({ receiver: userId, status: 'pending' })
            .populate('sender', 'username');

        // Collect all sockets for this user
        const userSockets = onlineUsers.get(userId); // userId is an ObjectId
        if (userSockets) {
            console.log(`Server: emitFriendAndRequestData - User ${user.username} has ${userSockets.size} active sockets.`);
            userSockets.forEach(socketId => {
                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    const friendUsernames = user.friends.map(f => f.username);
                    const incomingReqData = incomingRequests.map(r => ({
                        id: r._id, // Send request ID for accept/reject
                        username: r.sender.username
                    }));
                    const outgoingReqUsernames = outgoingRequests.map(r => r.receiver.username);

                    socket.emit('friend_list_updated', friendUsernames);
                    socket.emit('pending_requests_updated', {
                        outgoing: outgoingReqUsernames,
                        incoming: incomingReqData
                    });
                    console.log(`Server: emitFriendAndRequestData - Emitted to ${user.username} (socket: ${socketId}). Friends: ${friendUsernames.length}, Incoming Req: ${incomingReqData.length}, Outgoing Req: ${outgoingReqUsernames.length}`);
                } else {
                    console.warn(`Server: emitFriendAndRequestData - Socket ${socketId} not found in io.sockets.sockets for user ${user.username}.`);
                }
            });
        } else {
            console.log(`Server: emitFriendAndRequestData - No active sockets found for user ${user.username} (${userId}).`);
        }
    } catch (error) {
        console.error('Server: emitFriendAndRequestData - Error fetching/emitting friend/request data:', error);
    }
}


// --- Socket.IO Connection Handler ---
io.on('connection', async (socket) => { // Made async to use await for DB calls
    // Access session data via socket.request.session
    const userId = socket.request.session.userId;
    const username = socket.request.session.username;

    console.log(`Server: Socket connected. Session user ID: ${userId}, Username: ${username}, Socket ID: ${socket.id}`);

    if (!userId || !username) {
        console.log(`Server: Unauthenticated socket connection attempted (${socket.id}). Disconnecting.`);
        socket.disconnect(true); // Disconnect unauthenticated sockets
        return;
    }

    console.log(`Server: User ${username} (${socket.id}) authenticated and connected via Socket.IO`);

    // Add user's socket to the onlineUsers map
    if (!onlineUsers.has(userId)) { // userId is a Mongoose ObjectId
        onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);
    socketIdToUserId.set(socket.id, userId); // Map socket ID back to userId

    console.log(`Server: onlineUsers map state for ${username}: ${onlineUsers.get(userId).size} sockets. Total unique online users: ${Array.from(onlineUsers.keys()).length}`);

    // Initial data load for the connecting client
    socket.emit('current_user_info', { username: username }); // Send current user's username
    socket.emit('chat history', publicMessages); // Send public chat history
    console.log(`Server: Sent chat history (${publicMessages.length} messages) to ${username}.`);

    broadcastTypingStatus(); // Send full current typing status

    // Broadcast updated online users list to all clients (only online users, not friends yet)
    broadcastOnlineUsers();
    // Send user's specific friend data (friends and requests)
    emitFriendAndRequestData(userId); // userId is a Mongoose ObjectId

    // --- NEW: Load unread direct messages on connection ---
    try {
        const unreadDMs = await DirectMessage.find({ recipient: userId, read: false })
            .populate('sender', 'username') // Get sender's username
            .select('sender content timestamp');

        if (unreadDMs.length > 0) {
            console.log(`Server: User ${username} has ${unreadDMs.length} unread DMs. Emitting...`);
            unreadDMs.forEach(dm => {
                socket.emit('dm_message', {
                    sender: dm.sender.username,
                    recipient: username, // Explicitly the recipient for client-side display
                    text: dm.content,
                    timestamp: dm.timestamp.toLocaleTimeString(),
                    isDM: true,
                    dmId: dm._id.toString() // Send DM ID if client needs to mark it as read
                });
            });
            // Mark these messages as read after sending them to the client
            await DirectMessage.updateMany(
                { _id: { $in: unreadDMs.map(dm => dm._id) } },
                { $set: { read: true } }
            );
            console.log(`Server: Marked ${unreadDMs.length} DMs as read for ${username}.`);
        } else {
            console.log(`Server: No unread DMs for ${username}.`);
        }
    } catch (error) {
        console.error(`Server: Error loading unread DMs for ${username}:`, error);
    }


    // --- Friend Request Socket Events ---

    socket.on('send_friend_request', async (targetUsername) => {
        console.log(`Server: Received send_friend_request from ${username} to ${targetUsername}`);
        try {
            const senderUser = await User.findById(userId);
            const receiverUser = await User.findOne({ username: targetUsername });

            if (!senderUser || !receiverUser) {
                socket.emit('friend_request_error', `User '${targetUsername}' not found.`);
                console.log(`Server: Friend request failed: User '${targetUsername}' not found.`);
                return;
            }
            if (senderUser._id.equals(receiverUser._id)) {
                socket.emit('friend_request_error', 'Cannot send friend request to yourself.');
                console.log(`Server: Friend request failed: ${username} tried to send to self.`);
                return;
            }
            // Check if already friends
            if (senderUser.friends.includes(receiverUser._id)) {
                   socket.emit('friend_request_error', `You are already friends with ${targetUsername}.`);
                   console.log(`Server: Friend request failed: ${username} already friends with ${targetUsername}.`);
                   return;
            }

            // Check if request already exists (pending)
            const existingRequest = await FriendRequest.findOne({
                $or: [
                    { sender: senderUser._id, receiver: receiverUser._id, status: 'pending' },
                    { sender: receiverUser._id, receiver: senderUser._id, status: 'pending' } // Already received request
                ]
            });
            if (existingRequest) {
                if (existingRequest.sender.equals(receiverUser._id)) {
                    socket.emit('friend_request_error', `You have a pending friend request from ${targetUsername}. Accept it!`);
                    console.log(`Server: Friend request failed: Incoming request exists from ${targetUsername} to ${username}.`);
                } else {
                    socket.emit('friend_request_error', `Friend request to ${targetUsername} is already pending.`);
                    console.log(`Server: Friend request failed: Outgoing request already pending from ${username} to ${targetUsername}.`);
                }
                return;
            }


            const newRequest = new FriendRequest({
                sender: senderUser._id,
                receiver: receiverUser._id,
                status: 'pending'
            });
            await newRequest.save();

            console.log(`Server: Friend request sent: ${username} to ${targetUsername}`);
            socket.emit('friend_request_sent', targetUsername); // Notify sender

            // Notify recipient if online
            if (onlineUsers.has(receiverUser._id)) { // receiverUser._id is an ObjectId
                console.log(`Server: Notifying online receiver ${targetUsername} of new friend request.`);
                emitFriendAndRequestData(receiverUser._id); // Refresh data for receiver
            } else {
                console.log(`Server: Receiver ${targetUsername} is offline, request saved.`);
                // For offline friend request notifications:
                // You could store a 'notification' in the DB for the recipient
                // and load these notifications on login, similar to unread DMs.
                // For simplicity here, we're just updating their friend list in DB,
                // and it will be fetched on their next login when emitFriendAndRequestData runs.
            }

        } catch (error) {
            console.error('Server: Error sending friend request:', error);
            socket.emit('friend_request_error', 'Failed to send friend request.');
        }
    });

    socket.on('respond_friend_request', async ({ requestId, action }) => {
        console.log(`Server: Received respond_friend_request for ID ${requestId} with action ${action} from ${username}.`);
        try {
            const request = await FriendRequest.findById(requestId);

            if (!request || !request.receiver.equals(userId) || request.status !== 'pending') {
                socket.emit('friend_request_error', 'Invalid or already processed friend request.');
                console.warn(`Server: Invalid or processed friend request attempt by ${username} for ID ${requestId}.`);
                return;
            }

            if (action === 'accept') {
                request.status = 'accepted';
                await request.save();

                const senderUser = await User.findById(request.sender);
                const receiverUser = await User.findById(request.receiver);

                if (senderUser && receiverUser) {
                    // Add each other to friends list if not already
                    if (!senderUser.friends.includes(receiverUser._id)) {
                        senderUser.friends.push(receiverUser._id);
                        await senderUser.save();
                        console.log(`Server: Added ${receiverUser.username} to ${senderUser.username}'s friends.`);
                    } else {
                           console.log(`Server: ${receiverUser.username} already in ${senderUser.username}'s friends.`);
                    }
                    if (!receiverUser.friends.includes(senderUser._id)) {
                        receiverUser.friends.push(senderUser._id);
                        await receiverUser.save();
                        console.log(`Server: Added ${senderUser.username} to ${receiverUser.username}'s friends.`);
                    } else {
                        console.log(`Server: ${senderUser.username} already in ${receiverUser.username}'s friends.`);
                    }

                    console.log(`Server: Friend request accepted: ${receiverUser.username} accepted ${senderUser.username}.`);

                    // Notify both users of status change and update their friend lists
                    // These calls to emitFriendAndRequestData use the correct userId (Mongoose ObjectId)
                    await emitFriendAndRequestData(senderUser._id);
                    await emitFriendAndRequestData(receiverUser._id); // This will update if the recipient is online
                    // If recipient was offline, they will see updated friend list on next login/connect.

                } else {
                    console.error('Server: Error: Sender or receiver user not found after accepting request.');
                    socket.emit('friend_request_error', 'User data missing after acceptance.');
                }
            } else if (action === 'reject') {
                request.status = 'rejected';
                await request.save();
                console.log(`Server: Friend request rejected: ${username} rejected from ${request.sender.username}.`);
                await emitFriendAndRequestData(userId); // Update current user's requests
                // Optionally notify sender that request was rejected
                if (onlineUsers.has(request.sender)) {
                    console.log(`Server: Notifying sender ${request.sender.username} of rejection.`);
                    emitFriendAndRequestData(request.sender);
                }
            } else {
                socket.emit('friend_request_error', 'Invalid action for friend request.');
                console.warn(`Server: Invalid action for friend request: ${action}.`);
            }

        } catch (error) {
            console.error('Server: Error responding to friend request:', error);
            socket.emit('friend_request_error', 'Failed to respond to friend request.');
        }
    });

    // --- Public Chat Message Socket Event ---
    socket.on('chat message', (msg) => {
        console.log(`Server: Received public chat message from ${username}: "${msg}"`);
        const messageData = {
            user: username,
            text: msg,
            timestamp: new Date().toLocaleTimeString()
        };
        publicMessages.push(messageData); // Store in in-memory history
        io.emit('chat message', messageData); // Broadcast to ALL connected clients
        console.log(`Server: Broadcasted public message from ${username}. Data:`, messageData);

        // Stop typing after sending a message (public or DM)
        if (typingUsers.has(username)) {
            const currentTypingRecipients = typingUsers.get(username);
            if (currentTypingRecipients.has(null)) { // If public, stop public typing
                currentTypingRecipients.delete(null);
                console.log(`Server: ${username} stopped public typing.`);
            }
            if (currentTypingRecipients.size === 0) {
                typingUsers.delete(username);
                console.log(`Server: ${username} no longer typing to anyone.`);
            }
            broadcastTypingStatus();
        }
    });

    // --- Direct Message Socket Events ---

    // Listen for direct messages
    socket.on('send_dm', async ({ recipientUsername, message }) => {
        const senderUsername = username; // Sender's username is from the current socket's session
        console.log(`Server: Received DM from ${senderUsername} to ${recipientUsername}: "${message}"`);

        // Find the recipient's User document to get their ID
        const recipientUser = await User.findOne({ username: recipientUsername }).select('_id');

        if (!recipientUser) {
            socket.emit('dm_error', `User '${recipientUsername}' not found.`);
            console.warn(`Server: DM failed: Recipient '${recipientUsername}' not found.`);
            return;
        }

        // Check if sender and recipient are friends
        const senderUser = await User.findById(userId).select('friends');
        // Convert Mongoose ObjectIds to strings for comparison
        const senderFriendIds = senderUser.friends.map(id => id.toString());
        if (!senderUser || !senderFriendIds.includes(recipientUser._id.toString())) {
            socket.emit('dm_error', `You are not friends with ${recipientUsername}.`);
            console.warn(`Server: DM attempt denied: ${senderUsername} to ${recipientUsername} (not friends). Sender's friends: ${senderFriendIds}`);
            return;
        }

        // --- NEW: Save DM to database regardless of recipient's online status ---
        try {
            const newDM = new DirectMessage({
                sender: userId, // Sender's ObjectId
                recipient: recipientUser._id, // Recipient's ObjectId
                content: message,
                read: false // Mark as unread initially
            });
            await newDM.save();
            console.log(`Server: DM saved to database: ${senderUsername} -> ${recipientUsername}`);
        } catch (dbError) {
            console.error('Server: Error saving DM to database:', dbError);
            socket.emit('dm_error', 'Failed to send message (database error).');
            return;
        }

        // Prepare message data to send to client(s)
        const messageData = {
            sender: senderUsername,
            recipient: recipientUsername, // The recipient username
            text: message,
            timestamp: new Date().toLocaleTimeString(),
            isDM: true // Flag to indicate it's a DM
        };

        // --- NEW: Attempt to send DM to online recipient(s) ---
        const recipientSockets = onlineUsers.get(recipientUser._id); // recipientUser._id is an ObjectId
        if (recipientSockets && recipientSockets.size > 0) {
            console.log(`Server: Attempting to send DM from ${senderUsername} to online recipient ${recipientUsername} across ${recipientSockets.size} sockets.`);
            recipientSockets.forEach(recipientSocketId => {
                io.to(recipientSocketId).emit('dm_message', messageData);
                console.log(`Server: DM emitted to socket ${recipientSocketId} for ${recipientUsername}. Data:`, messageData);
            });
            // Optionally, if the message was delivered to an online recipient, you might
            // want to mark it as read immediately in the DB, or wait for a client confirmation.
            // For now, we'll keep it marked as unread until the client explicitly marks it.
        } else {
            console.log(`Server: Recipient '${recipientUsername}' is offline. DM saved and will be delivered on next login.`);
            socket.emit('dm_sent_offline', recipientUsername); // Optional: notify sender that recipient is offline
        }

        // Also send DM back to sender's other open tabs if any (client already handles it for originating tab)
        const senderSockets = onlineUsers.get(userId); // userId is an ObjectId
        if (senderSockets && senderSockets.size > 1) { // If sender has more than one socket
            console.log(`Server: Sending DM back to sender's other sockets (${senderSockets.size - 1} of them).`);
            senderSockets.forEach(senderSocketId => {
                if (senderSocketId !== socket.id) { // Don't send back to the originating socket, client already handles it
                    io.to(senderSocketId).emit('dm_message', messageData); // messageData already contains recipient
                    console.log(`Server: DM emitted to sender's other socket ${senderSocketId}. Data:`, messageData);
                }
            });
        }

        // Stop typing after sending a message (public or DM)
        if (typingUsers.has(username)) {
            const currentTypingRecipients = typingUsers.get(username);
            // If DM, stop typing for that specific recipient
            if (recipientUsername && currentTypingRecipients.has(recipientUsername)) {
                currentTypingRecipients.delete(recipientUsername);
                console.log(`Server: ${username} stopped typing to ${recipientUsername}.`);
            } else if (!recipientUsername && currentTypingRecipients.has(null)) { // If public, stop public typing
                currentTypingRecipients.delete(null);
                console.log(`Server: ${username} stopped public typing.`);
            }

            if (currentTypingRecipients.size === 0) {
                typingUsers.delete(username);
                console.log(`Server: ${username} no longer typing to anyone.`);
            }
            broadcastTypingStatus();
        }
    });

    // --- NEW: Event to request direct message history ---
    socket.on('request_dm_history', async (otherUsername) => {
        console.log(`Server: User ${username} requesting DM history with ${otherUsername}.`);
        try {
            const currentUser = await User.findById(userId);
            const otherUser = await User.findOne({ username: otherUsername });

            if (!currentUser || !otherUser) {
                socket.emit('dm_history_error', `User not found: ${otherUsername}`);
                console.warn(`Server: DM history request failed: ${otherUsername} not found.`);
                return;
            }

            // Check if they are friends before sending history
            // (You might relax this if you want DMs between non-friends, but for now, keep it)
            if (!currentUser.friends.includes(otherUser._id) && !otherUser.friends.includes(currentUser._id)) {
                   socket.emit('dm_history_error', `You are not friends with ${otherUsername}.`);
                   console.warn(`Server: DM history request denied: ${username} not friends with ${otherUsername}.`);
                   return;
            }

            // Find messages where current user is sender OR recipient with other user
            const conversation = await DirectMessage.find({
                $or: [
                    { sender: currentUser._id, recipient: otherUser._id },
                    { sender: otherUser._id, recipient: currentUser._id }
                ]
            })
            .sort({ timestamp: 1 }) // Sort by time, oldest first
            .populate('sender', 'username') // Populate sender's username
            .select('sender content timestamp');

            // Format for client
            const formattedHistory = conversation.map(msg => ({
                sender: msg.sender.username,
                // The recipient field for client display should be the other user's username
                // It's already included in the messageData we construct.
                recipient: (msg.sender._id.equals(currentUser._id) ? otherUser.username : currentUser.username), // Ensure recipient is consistent for client side
                text: msg.content,
                timestamp: msg.timestamp.toLocaleTimeString(),
                isDM: true
            }));

            console.log(`Server: Sending ${formattedHistory.length} DM history messages to ${username} for conversation with ${otherUsername}.`);
            socket.emit('dm_history', {
                withUser: otherUsername,
                history: formattedHistory
            });

            // Mark as read any messages in this history where the current user is the recipient
            // Note: This could be optimized to only mark if they were previously unread
            await DirectMessage.updateMany(
                { recipient: currentUser._id, sender: otherUser._id, read: false },
                { $set: { read: true } }
            );
            console.log(`Server: Marked DMs from ${otherUsername} to ${username} as read.`);

        } catch (error) {
            console.error(`Server: Error fetching DM history for ${username} with ${otherUsername}:`, error);
            socket.emit('dm_history_error', 'Failed to load message history.');
        }
    });


    // Listen for typing events (now includes recipient for DMs)
    // `isTyping` (boolean): true if typing, false if stopped
    // `recipient` (string | null): username of recipient if DM, null if public chat
    socket.on('typing', (isTypingStatus, recipientUsername = null) => {
        // Only process if user is authenticated (should be covered by initial check, but good for robustness)
        if (!username) {
            console.warn(`Server: Typing event from unauthenticated socket ${socket.id}.`);
            return;
        }
        console.log(`Server: Received typing status from ${username} (isTyping: ${isTypingStatus}, recipient: ${recipientUsername})`);
        if (!typingUsers.has(username)) {
            typingUsers.set(username, new Set());
        }
        const currentTypingRecipients = typingUsers.get(username);

        if (isTypingStatus) {
            currentTypingRecipients.add(recipientUsername);
        } else {
            currentTypingRecipients.delete(recipientUsername);
        }

        // Clean up if user is no longer typing to anyone
        if (currentTypingRecipients.size === 0) {
            typingUsers.delete(username);
        }
        broadcastTypingStatus(); // Broadcast updated typing status
    });

    // Handle client disconnects
    socket.on('disconnect', () => {
        const disconnectedUserId = socketIdToUserId.get(socket.id);
        if (disconnectedUserId) {
            // Retrieve username again for logging, as session might be destroying
            const disconnectedUsername = socket.request.session.username || 'unknown';

            console.log(`Server: User ${disconnectedUsername} (${socket.id}) disconnected.`);

            // Remove socket ID from onlineUsers map
            if (onlineUsers.has(disconnectedUserId)) {
                onlineUsers.get(disconnectedUserId).delete(socket.id);
                if (onlineUsers.get(disconnectedUserId).size === 0) {
                    onlineUsers.delete(disconnectedUserId); // Remove user if no more active sockets
                    // Also remove from typing status if they were typing publicly or to anyone
                    if (typingUsers.has(disconnectedUsername)) {
                        typingUsers.delete(disconnectedUsername);
                        console.log(`Server: Removed ${disconnectedUsername} from typing status.`);
                    }
                    console.log(`Server: User ${disconnectedUsername} is now fully offline.`);
                } else {
                       console.log(`Server: ${disconnectedUsername} still has ${onlineUsers.get(disconnectedUserId).size} active sockets.`);
                }
            }
            socketIdToUserId.delete(socket.id); // Remove from socketIdToUserId map

            // Broadcast updated online users list and typing status
            broadcastOnlineUsers();
            broadcastTypingStatus(); // Re-broadcast as a user might have stopped typing on disconnect
        } else {
            console.log(`Server: Unknown socket (${socket.id}) disconnected (no associated userId).`);
        }
    });
});


// --- Express Authentication Middleware (for protected routes) ---
function isAuthenticated(req, res, next) {
    if (req.session.userId) {
        console.log(`Server: isAuthenticated - User ${req.session.username} authenticated for ${req.path}.`);
        next();
    } else {
        console.log(`Server: isAuthenticated - Unauthorized access attempt to ${req.path}. Redirecting to login.`);
        res.redirect('/login.html?error=not_authenticated');
    }
}


// --- Express Routes ---

// Route to serve the registration page
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Route to handle registration POST requests
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    console.log(`Server: Registration attempt for username: ${username}`);

    if (!username || !password) {
        return res.redirect('/register.html?error=missing_credentials');
    }

    try {
        const newUser = new User({ username, password });
        await newUser.save();
        console.log(`Server: User registered: ${username}`);
        res.redirect('/login.html?registrationSuccess=true');
    } catch (error) {
        if (error.code === 11000) { // Duplicate key error code for MongoDB (username unique)
            console.error(`Server: Registration error: Username '${username}' already exists.`);
            return res.redirect('/register.html?error=username_taken');
        }
        console.error('Server: Registration error:', error);
        res.status(500).send('An error occurred during registration.');
    }
});

// Route to serve the login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Route to handle login POST requests
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    console.log(`Server: Login attempt for username: ${username}`);

    if (!username || !password) {
        return res.redirect('/login.html?error=missing_credentials');
    }

    try {
        const user = await User.findOne({ username });

        if (!user || !(await user.comparePassword(password))) {
            console.log(`Server: Failed login for ${username}: Invalid credentials.`);
            return res.redirect('/login.html?error=invalid_credentials');
        }

        // Regenerate session ID to prevent session fixation attacks after login
        // The redirect and setting of session data MUST happen inside this callback
        req.session.regenerate(function(err) {
            if (err) {
                console.error('Server: Session regeneration error after login:', err);
                return res.status(500).send('An internal error occurred during login.');
            }

            // Set session data AFTER regeneration is complete
            req.session.userId = user._id;
            req.session.username = user.username;

            // Save the session with the new data. This is crucial for Socket.IO to pick it up.
            req.session.save(function(err) {
                if (err) {
                    console.error('Server: Session save error after login:', err);
                    return res.status(500).send('An internal error occurred during login.');
                }
                console.log(`Server: User logged in: ${username}. New Session ID: ${req.session.id}. Redirecting to /home.html`);
                res.redirect('/home.html');
            });
        });

    } catch (error) {
        console.error('Server: Login error:', error);
        res.status(500).send('An error occurred during login.');
    }
});

// Protected route for the home page (chat room) - requires authentication
app.get('/home.html', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Logout route
app.get('/logout', (req, res) => {
    const usernameToLog = req.session.username || 'unknown'; // Get username before session is destroyed
    console.log(`Server: Logout attempt for user: ${usernameToLog}`);
    req.session.destroy(err => {
        if (err) {
            console.error('Server: Error destroying session:', err);
            return res.status(500).send('Could not log out.');
        }
        console.log(`Server: Session destroyed for user: ${usernameToLog}`);
        res.clearCookie('connect.sid'); // Clear the session cookie from the browser
        res.redirect('/login.html?loggedOut=true'); // Redirect to login page with a success message
    });
});


// Default route - redirects to the login page
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// Start the HTTP server (which serves Express and Socket.IO)
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Access the application via http://localhost:${PORT}`);
    console.log('Remember to start your MongoDB instance!');
});