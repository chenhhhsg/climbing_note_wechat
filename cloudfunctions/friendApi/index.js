/**
 * 好友关系与数据访问云函数
 *
 * 所有操作通过 wx.cloud.getWXContext().OPENID 获取真实用户身份
 * 不信任前端传入的 openid
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const usersCol = db.collection('users');
const friendshipsCol = db.collection('friendships');
const sessionsCol = db.collection('climbing_sessions');

// ============================================
// 工具方法
// ============================================

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function generateUniqueInviteCode() {
  let code;
  let exists = true;
  let attempts = 0;
  while (exists && attempts < 10) {
    code = generateInviteCode();
    const res = await usersCol.where({ inviteCode: code }).count();
    exists = res.total > 0;
    attempts++;
  }
  if (exists) throw new Error('邀请码生成失败，请重试');
  return code;
}

function pairOpenids(a, b) {
  return a < b ? { userA: a, userB: b } : { userA: b, userB: a };
}

async function checkFriendship(openidA, openidB) {
  const pair = pairOpenids(openidA, openidB);
  const res = await friendshipsCol.where({
    userA: pair.userA,
    userB: pair.userB,
    status: 'accepted'
  }).count();
  return res.total > 0;
}

// ============================================
// action 处理函数
// ============================================

async function loginOrCreateUser(openid) {
  const existing = await usersCol.where({ _openid: openid }).get();
  if (existing.data.length > 0) {
    return { success: true, data: existing.data[0], created: false };
  }

  const inviteCode = await generateUniqueInviteCode();
  const now = Date.now();
  const doc = {
    _openid: openid,
    nickName: '',
    avatarUrl: '',
    inviteCode,
    createdAt: now,
    updatedAt: now
  };

  const res = await usersCol.add({ data: doc });
  doc._id = res._id;
  return { success: true, data: doc, created: true };
}

async function getInviteCode(openid) {
  const res = await usersCol.where({ _openid: openid }).get();
  if (res.data.length === 0) {
    return { success: false, error: '用户不存在' };
  }
  let user = res.data[0];
  if (!user.inviteCode) {
    const inviteCode = await generateUniqueInviteCode();
    await usersCol.doc(user._id).update({
      data: { inviteCode, updatedAt: Date.now() }
    });
    user.inviteCode = inviteCode;
  }
  return { success: true, data: { inviteCode: user.inviteCode } };
}

async function acceptFriendInvite(openid, inviteCode) {
  if (!inviteCode || typeof inviteCode !== 'string') {
    return { success: false, error: '请输入邀请码' };
  }

  const targetRes = await usersCol.where({ inviteCode: inviteCode.toUpperCase() }).get();
  if (targetRes.data.length === 0) {
    return { success: false, error: '邀请码无效' };
  }

  const targetUser = targetRes.data[0];
  const targetOpenid = targetUser._openid;

  if (targetOpenid === openid) {
    return { success: false, error: '不能添加自己为好友' };
  }

  const already = await checkFriendship(openid, targetOpenid);
  if (already) {
    return { success: false, error: '你们已经是好友了' };
  }

  const pair = pairOpenids(openid, targetOpenid);
  await friendshipsCol.add({
    data: {
      ...pair,
      requester: openid,
      status: 'accepted',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  });

  return {
    success: true,
    data: {
      friendNickName: targetUser.nickName || '未设置昵称',
      friendAvatarUrl: targetUser.avatarUrl || ''
    }
  };
}

async function getMyFriends(openid) {
  const [resA, resB] = await Promise.all([
    friendshipsCol.where({ userA: openid, status: 'accepted' }).get(),
    friendshipsCol.where({ userB: openid, status: 'accepted' }).get()
  ]);

  const friendOpenids = [];
  resA.data.forEach(f => friendOpenids.push(f.userB));
  resB.data.forEach(f => friendOpenids.push(f.userA));

  if (friendOpenids.length === 0) {
    return { success: true, data: [] };
  }

  const usersRes = await usersCol.where({
    _openid: _.in(friendOpenids)
  }).get();

  const friends = usersRes.data.map(u => ({
    _openid: u._openid,
    nickName: u.nickName || '未设置昵称',
    avatarUrl: u.avatarUrl || ''
  }));

  return { success: true, data: friends };
}

async function getFriendSessions(openid, friendOpenid, page = 1, pageSize = 20) {
  if (!friendOpenid || friendOpenid === 'all') {
    return getAllFriendSessions(openid, page, pageSize);
  }

  const isFriend = await checkFriendship(openid, friendOpenid);
  if (!isFriend) {
    return { success: false, error: '你们不是好友' };
  }

  const skip = (page - 1) * pageSize;
  const where = {
    _openid: friendOpenid,
    visibility: 'friends'
  };

  const [listRes, countRes] = await Promise.all([
    sessionsCol.where(where).orderBy('timestamp', 'desc').skip(skip).limit(pageSize).get(),
    sessionsCol.where(where).count()
  ]);

  const usersRes = await usersCol.where({ _openid: friendOpenid }).get();
  const userInfo = usersRes.data[0] || {};

  const list = listRes.data.map(s => ({
    ...s,
    friendNickName: userInfo.nickName || '未设置昵称',
    friendAvatarUrl: userInfo.avatarUrl || ''
  }));

  return { success: true, data: { list, total: countRes.total, page, pageSize } };
}

async function getAllFriendSessions(openid, page = 1, pageSize = 20) {
  const [resA, resB] = await Promise.all([
    friendshipsCol.where({ userA: openid, status: 'accepted' }).get(),
    friendshipsCol.where({ userB: openid, status: 'accepted' }).get()
  ]);

  const friendOpenids = [];
  resA.data.forEach(f => friendOpenids.push(f.userB));
  resB.data.forEach(f => friendOpenids.push(f.userA));

  if (friendOpenids.length === 0) {
    return { success: true, data: { list: [], total: 0, page, pageSize } };
  }

  const where = {
    _openid: _.in(friendOpenids),
    visibility: 'friends'
  };

  const skip = (page - 1) * pageSize;
  const [listRes, countRes] = await Promise.all([
    sessionsCol.where(where).orderBy('timestamp', 'desc').skip(skip).limit(pageSize).get(),
    sessionsCol.where(where).count()
  ]);

  const usersRes = await usersCol.where({
    _openid: _.in(friendOpenids)
  }).get();

  const userMap = {};
  usersRes.data.forEach(u => {
    userMap[u._openid] = {
      nickName: u.nickName || '未设置昵称',
      avatarUrl: u.avatarUrl || ''
    };
  });

  const list = listRes.data.map(s => ({
    ...s,
    friendNickName: (userMap[s._openid] || {}).nickName || '未设置昵称',
    friendAvatarUrl: (userMap[s._openid] || {}).avatarUrl || ''
  }));

  return { success: true, data: { list, total: countRes.total, page, pageSize } };
}

async function getFriendSessionDetail(openid, sessionId) {
  if (!sessionId) {
    return { success: false, error: '缺少 sessionId' };
  }

  let session;
  try {
    const res = await sessionsCol.doc(sessionId).get();
    session = res.data;
  } catch (e) {
    return { success: false, error: '记录不存在' };
  }

  if (session.visibility !== 'friends') {
    return { success: false, error: '该记录未公开' };
  }

  const sessionOwnerOpenid = session._openid;
  if (sessionOwnerOpenid === openid) {
    return { success: true, data: session };
  }

  const isFriend = await checkFriendship(openid, sessionOwnerOpenid);
  if (!isFriend) {
    return { success: false, error: '你们不是好友' };
  }

  const usersRes = await usersCol.where({ _openid: sessionOwnerOpenid }).get();
  const userInfo = usersRes.data[0] || {};

  return {
    success: true,
    data: {
      ...session,
      friendNickName: userInfo.nickName || '未设置昵称',
      friendAvatarUrl: userInfo.avatarUrl || ''
    }
  };
}

async function setSessionVisibility(openid, sessionId, visibility) {
  if (!['private', 'friends'].includes(visibility)) {
    return { success: false, error: 'visibility 只能是 private 或 friends' };
  }

  let session;
  try {
    const res = await sessionsCol.doc(sessionId).get();
    session = res.data;
  } catch (e) {
    return { success: false, error: '记录不存在' };
  }

  if (session._openid !== openid) {
    return { success: false, error: '只能修改自己的记录' };
  }

  await sessionsCol.doc(sessionId).update({
    data: { visibility, updatedAt: Date.now() }
  });

  return { success: true, data: { visibility } };
}

async function removeFriend(openid, friendOpenid) {
  if (!friendOpenid) {
    return { success: false, error: '缺少 friendOpenid' };
  }

  const pair = pairOpenids(openid, friendOpenid);
  const res = await friendshipsCol.where(pair).remove();

  return { success: true, data: { removed: res.stats.removed } };
}

async function getUserInfo(targetOpenid) {
  if (!targetOpenid) {
    return { success: false, error: '缺少 targetOpenid' };
  }

  const res = await usersCol.where({ _openid: targetOpenid }).get();
  if (res.data.length === 0) {
    return { success: false, error: '用户不存在' };
  }

  const u = res.data[0];
  return {
    success: true,
    data: {
      nickName: u.nickName || '未设置昵称',
      avatarUrl: u.avatarUrl || ''
    }
  };
}

// ============================================
// 云函数入口
// ============================================

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  if (!openid) {
    return { success: false, error: '未获取到用户身份' };
  }

  const { action } = event;

  try {
    switch (action) {
      case 'loginOrCreateUser':
        return await loginOrCreateUser(openid);

      case 'createFriendInvite':
        return await getInviteCode(openid);

      case 'acceptFriendInvite':
        return await acceptFriendInvite(openid, event.inviteCode);

      case 'getMyFriends':
        return await getMyFriends(openid);

      case 'getFriendSessions':
        return await getFriendSessions(openid, event.friendOpenid, event.page, event.pageSize);

      case 'getFriendSessionDetail':
        return await getFriendSessionDetail(openid, event.sessionId);

      case 'setSessionVisibility':
        return await setSessionVisibility(openid, event.sessionId, event.visibility);

      case 'removeFriend':
        return await removeFriend(openid, event.friendOpenid);

      case 'getUserInfo':
        return await getUserInfo(event.targetOpenid);

      default:
        return { success: false, error: `未知 action: ${action}` };
    }
  } catch (err) {
    console.error(`[friendApi] action=${action} error:`, err);
    return { success: false, error: err.message || '服务器错误' };
  }
};
