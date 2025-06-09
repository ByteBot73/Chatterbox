// models/DirectMessage.js
const mongoose = require('mongoose');

const directMessageSchema = new mongoose.Schema({
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    recipient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    content: { // Changed from 'text' to 'content' to match your schema
        type: String,
        required: true,
        trim: true
    },
    // The key update for TTL:
    // Mongoose's `timestamps: true` adds `createdAt` and `updatedAt`.
    // We explicitly define `createdAt` here to add the `expires` property.
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 60 // Documents will be automatically deleted after 60 seconds (1 minute)
                    // MongoDB TTL index uses seconds.
    },
    read: {
        type: Boolean,
        default: false
    }
}, {
    // Keep timestamps: true if you also want the `updatedAt` field,
    // but the `createdAt` field defined above takes precedence for its options.
    timestamps: false // Set to false here because we explicitly define createdAt.
                      // If you still need `updatedAt`, you'd manually add it or revert this.
                      // For message deletion, only `createdAt` is relevant.
});

// Remove the redundant `timestamp` index, as `createdAt` will now handle the time-based querying.
// You might still want to optimize queries by sender/recipient, but the indexes below cover that.
// directMessageSchema.index({ sender: 1, recipient: 1, timestamp: 1 }); // Remove this line

// Keep indexes for efficient querying of conversations
directMessageSchema.index({ sender: 1, recipient: 1, createdAt: 1 }); // Use createdAt instead of timestamp
directMessageSchema.index({ recipient: 1, sender: 1, createdAt: 1 }); // Use createdAt instead of timestamp

module.exports = mongoose.model('DirectMessage', directMessageSchema);