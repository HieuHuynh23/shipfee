'use strict';

function registerOrderCallRoutes(app, ctx) {
  const {
  rateLimitStrict,
  requireOrderPartyForCall,
  activeCalls,
  realtimeHub
  } = ctx;

app.post('/api/orders/:id/call/initiate', rateLimitStrict, async (req, res) => {
  const access = await requireOrderPartyForCall(req, res);
  if (!access) return;
  const { id } = req.params;
  const { offer } = req.body;
  const caller = access.authz.role === 'shipper' ? 'shipper' : 'customer';

  activeCalls[id] = {
    status: 'ringing',
    caller,
    offer: offer || null,
    answer: null,
    callerCandidates: [],
    calleeCandidates: [],
    timestamp: Date.now(),
    lastPollCustomer: Date.now(),
    lastPollShipper: Date.now()
  };

  console.log(`[Call Server] 📞 Khởi tạo cuộc gọi cho đơn ${id} bởi ${caller}`);
  try {
    realtimeHub.publishCallUpdate(id, activeCalls[id], {
      shipperPhone: access.order.shipperPhone,
      assignedShipperPhone: access.order.assignedShipperPhone
    });
  } catch (_) {}
  res.json({ success: true, call: activeCalls[id] });
});

/**
 * POST /api/orders/:id/call/respond
 */
app.post('/api/orders/:id/call/respond', async (req, res) => {
  const access = await requireOrderPartyForCall(req, res);
  if (!access) return;
  const { id } = req.params;
  const { action, answer } = req.body;

  const call = activeCalls[id];
  if (!call) {
    return res.status(404).json({ error: 'Không có cuộc gọi hoạt động cho đơn hàng này' });
  }

  if (action === 'accept') {
    call.status = 'connected';
    if (answer) call.answer = answer;
    console.log(`[Call Server] 📞 Cuộc gọi cho đơn ${id} đã được chấp nhận`);
  } else if (action === 'decline' || action === 'end') {
    call.status = 'ended';
    console.log(`[Call Server] 📞 Cuộc gọi cho đơn ${id} ${action === 'decline' ? 'bị từ chối' : 'kết thúc'}`);
    setTimeout(() => { delete activeCalls[id]; }, 60_000);
  }

  try {
    realtimeHub.publishCallUpdate(id, call, {
      shipperPhone: access.order.shipperPhone,
      assignedShipperPhone: access.order.assignedShipperPhone
    });
  } catch (_) {}
  res.json({ success: true, call });
});

/**
 * POST /api/orders/:id/call/candidate
 */
app.post('/api/orders/:id/call/candidate', async (req, res) => {
  const access = await requireOrderPartyForCall(req, res);
  if (!access) return;
  const { id } = req.params;
  const { sender, candidate } = req.body;

  const call = activeCalls[id];
  if (!call) {
    return res.status(404).json({ error: 'Không có cuộc gọi hoạt động' });
  }

  const role = access.authz.role === 'shipper' ? 'shipper' : 'customer';
  const from = sender === 'shipper' || sender === 'customer' ? sender : role;
  const listKey = from === call.caller ? 'callerCandidates' : 'calleeCandidates';
  if (!Array.isArray(call[listKey])) call[listKey] = [];
  if (call[listKey].length < 50 && candidate) {
    call[listKey].push(candidate);
  }

  res.json({ success: true });
});

/**
 * GET /api/orders/:id/call/poll
 */
app.get('/api/orders/:id/call/poll', async (req, res) => {
  const access = await requireOrderPartyForCall(req, res);
  if (!access) return;
  const { id } = req.params;
  const role = access.authz.role === 'shipper' ? 'shipper' : 'customer';
  const call = activeCalls[id] || null;

  if (call) {
    const now = Date.now();
    if (role === 'customer') {
      call.lastPollCustomer = now;
    } else if (role === 'shipper') {
      call.lastPollShipper = now;
    }

    if (call.status === 'ringing' || call.status === 'connected') {
      const customerTimeout = call.lastPollCustomer && (now - call.lastPollCustomer > 6000);
      const shipperTimeout = call.lastPollShipper && (now - call.lastPollShipper > 6000);
      const ringTimeout = call.status === 'ringing' && (now - call.timestamp > 30000);

      if (customerTimeout || shipperTimeout || ringTimeout) {
        console.log(`[Call Server] 📞 Auto-ending call for order ${id} due to connection timeout or inactive polling`);
        call.status = 'ended';
        setTimeout(() => { delete activeCalls[id]; }, 60_000);
      }
    }
  }

  res.json({ success: true, call });
});


}

module.exports = { registerOrderCallRoutes };
