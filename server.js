// server.js

// Load environment variables from .env file at the very beginning
require('dotenv').config();

// Core Node.js and Express imports
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const http = require('http'); // Required for Socket.IO

// Authentication and Session management
const session = require('express-session');

// Real-time communication (WebSockets)
const { Server } = require('socket.io');

// Our Mongoose models
const User = require('./models/User');
const FriendRequest = require('./models/FriendRequest');

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
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 24 hours (milliseconds)
        // secure: true, // IMPORTANT: Use this in production with HTTPS
        // httpOnly: true // IMPORTANT: Prevents client-side JS from accessing the cookie
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

// Broadcasts updated online users (including their usernames)
async function broadcastOnlineUsers() {
    const onlineUsernames = [];
    for (let userId of onlineUsers.keys()) {
        const user = await User.findById(userId).select('username');
        if (user) {
            onlineUsernames.push(user.username);
        }
    }
    io.emit('online_users_list', onlineUsernames);
    console.log('Server: Online users broadcasted:', onlineUsernames);
}

// Broadcasts typing status to all clients
function broadcastTypingStatus() {
    const typingMapForClient = {};
    typingUsers.forEach((recipientsSet, username) => {
        typingMapForClient[username] = Array.from(recipientsSet);
    });
    io.emit('typing status', typingMapForClient);
    console.log('Server: Typing status broadcasted:', typingMapForClient);
}

// Emits friend list and pending requests to a specific user (all their connected sockets)
async function emitFriendAndRequestData(userId) {
    const user = await User.findById(userId)
        .populate('friends', 'username') // Populate friends to get usernames
        .select('username friends');

    if (!user) {
        console.warn(`Server: User not found for friend/request data emit: ${userId}`);
        return;
    }

    // Get outgoing pending requests
    const outgoingRequests = await FriendRequest.find({ sender: userId, status: 'pending' })
        .populate('receiver', 'username');

    // Get incoming pending requests
    const incomingRequests = await FriendRequest.find({ receiver: userId, status: 'pending' })
        .populate('sender', 'username');

    // Collect all sockets for this user
    const userSockets = onlineUsers.get(userId);
    if (userSockets) {
        userSockets.forEach(socketId => {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.emit('friend_list_updated', user.friends.map(f => f.username));
                socket.emit('pending_requests_updated', {
                    outgoing: outgoingRequests.map(r => r.receiver.username),
                    incoming: incomingRequests.map(r => ({
                        id: r._id, // Send request ID for accept/reject
                        username: r.sender.username
                    }))
                });
                console.log(`Server: Emitted friend/request data to ${user.username} (socket: ${socketId}). Friends: ${user.friends.length}, Incoming Req: ${incomingRequests.length}`);
            }
        });
    } else {
        console.log(`Server: No active sockets found for user ${user.username} (${userId}) to emit friend/request data.`);
    }
}


// --- Socket.IO Connection Handler ---
io.on('connection', (socket) => {
    const userId = socket.request.session.userId;
    const username = socket.request.session.username; // This is the current user's username

    if (!userId || !username) {
        console.log(`Server: Unauthenticated socket connection attempted (${socket.id}). Disconnecting.`);
        socket.disconnect(true);
        return;
    }

    console.log(`Server: User ${username} (${socket.id}) connected via Socket.IO`);

    // Add user's socket to the onlineUsers map
    if (!onlineUsers.has(userId)) {
        onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);
    socketIdToUserId.set(socket.id, userId); // Map socket ID back to userId

    console.log(`Server: onlineUsers map state for ${username}: ${onlineUsers.get(userId).size} sockets.`);

    // Initial data load for the connecting client
    socket.emit('current_user_info', { username: username }); // Send current user's username
    socket.emit('chat history', publicMessages); // Send public chat history
    console.log(`Server: Sent chat history (${publicMessages.length} messages) to ${username}.`);

    broadcastTypingStatus(); // Send full current typing status

    // Broadcast updated online users list to all clients (only online users, not friends yet)
    broadcastOnlineUsers();
    // Send user's specific friend data
    emitFriendAndRequestData(userId);


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
            if (onlineUsers.has(receiverUser._id)) {
                console.log(`Server: Notifying online receiver ${targetUsername} of new friend request.`);
                emitFriendAndRequestData(receiverUser._id); // Refresh data for receiver
            } else {
                console.log(`Server: Receiver ${targetUsername} is offline, request saved.`);
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
                    }
                    if (!receiverUser.friends.includes(senderUser._id)) {
                        receiverUser.friends.push(senderUser._id);
                        await receiverUser.save();
                        console.log(`Server: Added ${senderUser.username} to ${receiverUser.username}'s friends.`);
                    }

                    console.log(`Server: Friend request accepted: ${receiverUser.username} accepted ${senderUser.username}.`);

                    // Notify both users of status change and update their friend lists
                    await emitFriendAndRequestData(senderUser._id);
                    await emitFriendAndRequestData(receiverUser._id);

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
        console.log(`Server: Received public chat message from ${username}: ${msg}`);
        const messageData = {
            user: username,
            text: msg,
            timestamp: new Date().toLocaleTimeString()
        };
        publicMessages.push(messageData); // Store in in-memory history
        io.emit('chat message', messageData); // Broadcast to ALL connected clients
        console.log(`Server: Broadcasted public message from ${username}. Data:`, messageData);
    });

    // --- Direct Message Socket Events ---

    // Listen for direct messages
    socket.on('send_dm', async ({ recipientUsername, message }) => {
        const senderUsername = username;
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
        if (!senderUser || !senderUser.friends.includes(recipientUser._id)) {
            socket.emit('dm_error', `You are not friends with ${recipientUsername}.`);
            console.warn(`Server: DM attempt denied: ${senderUsername} to ${recipientUsername} (not friends). Sender's friends: ${senderUser ? senderUser.friends : 'N/A'}`);
            return;
        }

        // Check if recipient is online
        const recipientSockets = onlineUsers.get(recipientUser._id);
        if (!recipientSockets || recipientSockets.size === 0) {
            socket.emit('dm_error', `User '${recipientUsername}' is currently offline.`);
            console.warn(`Server: DM attempt denied: ${senderUsername} to ${recipientUsername} (offline or no active sockets).`);
            return;
        }

        // *** UPDATED: Added 'recipient' field for client-side clarity ***
        const messageData = {
            sender: senderUsername,
            recipient: recipientUsername, // The recipient username
            text: message,
            timestamp: new Date().toLocaleTimeString(),
            isDM: true
        };

        // Send DM to all sockets of the recipient
        console.log(`Server: Attempting to send DM from ${senderUsername} to ${recipientUsername} across ${recipientSockets.size} sockets.`);
        recipientSockets.forEach(recipientSocketId => {
            io.to(recipientSocketId).emit('dm_message', messageData);
            console.log(`Server: DM emitted to socket ${recipientSocketId} for ${recipientUsername}. Data:`, messageData);
        });

        // Also send DM back to sender's other open tabs if any
        const senderSockets = onlineUsers.get(userId);
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


    // Listen for typing events (now includes recipient for DMs)
    // `isTyping` (boolean): true if typing, false if stopped
    // `recipient` (string | null): username of recipient if DM, null if public chat
    socket.on('typing', (isTypingStatus, recipientUsername = null) => {
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
            const disconnectedUsername = socket.request.session.username || 'unknown'; // Get username from session

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
            console.log(`Server: Unknown socket (${socket.id}) disconnected.`);
        }
    });
});


// --- Express Authentication Middleware (for protected routes) ---
function isAuthenticated(req, res, next) {
    if (req.session.userId) {
        next();
    } else {
        console.log(`Server: Unauthorized access attempt to ${req.path}. Redirecting to login.`);
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
        if (error.code === 11000) {
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

        req.session.userId = user._id;
        req.session.username = user.username;
        console.log(`Server: User logged in: ${username}. Session ID: ${req.session.id}`);

        res.redirect('/home.html');

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
    const usernameToLog = req.session.username || 'unknown';
    console.log(`Server: Logout attempt for user: ${usernameToLog}`);
    req.session.destroy(err => {
        if (err) {
            console.error('Server: Error destroying session:', err);
            return res.status(500).send('Could not log out.');
        }
        console.log(`Server: Session destroyed for user: ${usernameToLog}`);
        res.clearCookie('connect.sid');
        res.redirect('/login.html?loggedOut=true');
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