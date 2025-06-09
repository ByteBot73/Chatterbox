// models/FriendRequest.js
const mongoose = require('mongoose');

const FriendRequestSchema = new mongoose.Schema({
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    receiver: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'accepted', 'rejected'],
        default: 'pending'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    // Add expires only for 'accepted' requests
    expires: {
        type: Date,
        default: function() {
            // Only set an expiration date if the status is 'accepted'
            return this.status === 'accepted' ? new Date(Date.now() + 60 * 60 * 24 * 1000) : undefined; // 1 day in milliseconds
        },
        index: { expires: '1d' } // Create an index with 1 day expiration
    }
});

// Ensure a user cannot send multiple pending requests to the same person
FriendRequestSchema.index({ sender: 1, receiver: 1 }, { unique: true });

const FriendRequest = mongoose.model('FriendRequest', FriendRequestSchema);

module.exports = FriendRequest;