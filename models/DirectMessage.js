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
    content: {
        type: String,
        required: true,
        trim: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    },
    read: { // Optional: to track if message has been read by the recipient
        type: Boolean,
        default: false
    }
}, { timestamps: true }); // Adds createdAt and updatedAt automatically

// Add indexes for efficient querying of conversations
directMessageSchema.index({ sender: 1, recipient: 1, timestamp: 1 });
directMessageSchema.index({ recipient: 1, sender: 1, timestamp: 1 });

module.exports = mongoose.model('DirectMessage', directMessageSchema);