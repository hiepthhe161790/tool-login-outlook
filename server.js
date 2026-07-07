const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { OutlookAccount, loginAndGetSession, getMails, addAccountsToQueue, getQueueStatus } = require('./outlookLogic');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/outlook_db';

mongoose.connect(MONGODB_URI).then(() => {
    console.log('✅ Đã kết nối MongoDB');
}).catch(err => {
    console.error('❌ Lỗi kết nối MongoDB:', err.message);
});

app.get('/api/accounts', async (req, res) => {
    const accounts = await OutlookAccount.find({}, { password: 0, sessionState: 0 }); 
    res.json(accounts);
});

// Nhập hàng loạt tài khoản
app.post('/api/accounts/bulk', async (req, res) => {
    const { accounts } = req.body; // Mảng [{email, password}]
    if (!accounts || !Array.isArray(accounts)) return res.status(400).json({ success: false });

    try {
        let addedCount = 0;
        for (const item of accounts) {
            let acc = await OutlookAccount.findOne({ email: item.email });
            if (acc) {
                acc.password = item.password; 
                if (item.proxy) acc.proxy = item.proxy;
                await acc.save();
            } else {
                await OutlookAccount.create({ 
                    email: item.email, 
                    password: item.password,
                    proxy: item.proxy
                });
                addedCount++;
            }
        }
        res.json({ success: true, message: `Đã nhập và cập nhật ${accounts.length} tài khoản (${addedCount} thêm mới)` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/accounts/:email/login', async (req, res) => {
    const { email } = req.params;
    try {
        const result = await loginAndGetSession(email);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Chạy Auto Login bằng Queue
app.post('/api/accounts/auto-login-all', async (req, res) => {
    try {
        const { emails } = req.body || {};
        let emailsToRun = [];

        if (emails && Array.isArray(emails) && emails.length > 0) {
            // Nếu có truyền danh sách chọn từ Client
            emailsToRun = emails;
        } else {
            // Mặc định: Lấy tất cả các nick lỗi hoặc chưa có session
            const accountsToRun = await OutlookAccount.find({ status: { $ne: 'active' } });
            emailsToRun = accountsToRun.map(acc => acc.email);
        }
        
        if (emailsToRun.length > 0) {
            addAccountsToQueue(emailsToRun);
            res.json({ success: true, message: `Đã thêm ${emailsToRun.length} tài khoản vào hàng đợi đăng nhập.` });
        } else {
            res.json({ success: true, message: 'Không có tài khoản nào cần chạy.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Xóa một tài khoản
app.delete('/api/accounts/:email', async (req, res) => {
    try {
        await OutlookAccount.deleteOne({ email: req.params.email });
        res.json({ success: true, message: 'Đã xóa tài khoản thành công.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Xóa hàng loạt tài khoản
app.post('/api/accounts/delete-bulk', async (req, res) => {
    const { emails } = req.body;
    if (!emails || !Array.isArray(emails)) return res.status(400).json({ success: false });
    try {
        await OutlookAccount.deleteMany({ email: { $in: emails } });
        res.json({ success: true, message: `Đã xóa thành công ${emails.length} tài khoản.` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Cập nhật mật khẩu và reset trạng thái
app.put('/api/accounts/:email', async (req, res) => {
    const { password } = req.body;
    try {
        const acc = await OutlookAccount.findOne({ email: req.params.email });
        if (!acc) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản.' });
        
        if (password) acc.password = password;
        acc.status = 'pending';
        acc.sessionState = undefined; // Bắt buộc đăng nhập lại
        await acc.save();
        
        res.json({ success: true, message: 'Đã cập nhật mật khẩu và Đặt lại trạng thái.' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Xuất file accounts
app.post('/api/accounts/export', async (req, res) => {
    try {
        const { emails } = req.body;
        let accountsToExport = [];
        if (emails && Array.isArray(emails) && emails.length > 0) {
            accountsToExport = await OutlookAccount.find({ email: { $in: emails } });
        } else {
            // Nếu không gửi danh sách, mặc định xuất tất cả
            accountsToExport = await OutlookAccount.find({});
        }

        const lines = accountsToExport.map(acc => {
            if (acc.proxy) {
                return `${acc.email}|${acc.password}|${acc.proxy}`;
            }
            return `${acc.email}|${acc.password}`;
        });
        
        const content = lines.join('\n');
        
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename=accounts_export.txt');
        res.send(content);
    } catch (error) {
        res.status(500).send('Lỗi khi xuất danh sách: ' + error.message);
    }
});

// Xem trạng thái hàng đợi
app.get('/api/queue-status', (req, res) => {
    res.json(getQueueStatus());
});

app.get('/api/accounts/:email/mails', async (req, res) => {
    const { email } = req.params;
    try {
        const mails = await getMails(email);
        res.json({ success: true, mails });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Web Server đang chạy tại: http://localhost:${PORT}`);
});
