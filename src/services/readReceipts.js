'use strict';

const ReadReceipt = require('../models/ReadReceipt');
const User = require('../models/User');

async function ensureTrackingStartedAt(user) {
  if (user.unreadTrackingStartedAt) return user.unreadTrackingStartedAt;

  await User.updateOne(
    { _id: user._id, unreadTrackingStartedAt: { $exists: false } },
    { $set: { unreadTrackingStartedAt: new Date() } }
  );
  const updatedUser = await User.findById(user._id).select('unreadTrackingStartedAt').lean();
  return updatedUser.unreadTrackingStartedAt;
}

async function markViewed(user, resourceType, resource) {
  await ReadReceipt.findOneAndUpdate(
    { user: user._id, resourceType, resourceId: resource._id },
    { $set: { seenUpdatedAt: resource.updatedAt || new Date() } },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

async function countUnread({ Model, user, resourceType, filter, baseline }) {
  const [result] = await Model.aggregate([
    { $match: filter },
    {
      $lookup: {
        from: ReadReceipt.collection.name,
        let: { resourceId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$user', user._id] },
                  { $eq: ['$resourceType', resourceType] },
                  { $eq: ['$resourceId', '$$resourceId'] }
                ]
              }
            }
          },
          { $project: { seenUpdatedAt: 1 } },
          { $limit: 1 }
        ],
        as: 'readReceipt'
      }
    },
    {
      $match: {
        $expr: {
          $or: [
            {
              $and: [
                { $eq: [{ $size: '$readReceipt' }, 0] },
                { $gt: ['$updatedAt', baseline] }
              ]
            },
            {
              $and: [
                { $gt: [{ $size: '$readReceipt' }, 0] },
                { $lt: [{ $arrayElemAt: ['$readReceipt.seenUpdatedAt', 0] }, '$updatedAt'] }
              ]
            }
          ]
        }
      }
    },
    { $count: 'count' }
  ]);
  return result?.count || 0;
}

async function countAwaitingResponse({ Model, user, role, filter }) {
  const [result] = await Model.aggregate([
    { $match: { $and: [filter, { status: { $ne: 'closed' } }] } },
    { $addFields: { latestMessage: { $arrayElemAt: ['$messages', -1] } } },
    { $match: { latestMessage: { $exists: true } } },
    {
      $match: role === 'admin'
        ? { 'latestMessage.authorRole': 'user' }
        : { 'latestMessage.author': { $ne: user._id } }
    },
    { $count: 'count' }
  ]);
  return result?.count || 0;
}

module.exports = { markViewed, countUnread, countAwaitingResponse, ensureTrackingStartedAt };
