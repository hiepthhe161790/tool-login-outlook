const { chromium } = require('playwright');
const mongoose = require('mongoose');
const inquirer = require('inquirer');
const fs = require('fs');
require('dotenv').config();

const OutlookAccountSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    sessionState: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, default: 'active' },
    lastLoginAt: { type: Date }
});

const OutlookAccount = mongoose.model('OutlookAccount', OutlookAccountSchema);

// Hàm Đăng nhập để lấy Cookie
async function loginAndGetSession(account) {
    const browser = await chromium.launch({ headless: false }); 
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log(`\n▶ Đang tiến hành đăng nhập: ${account.email}...`);
        await page.goto('https://login.live.com/');

        await page.fill('input[type="email"]', account.email);
        await page.click('input[type="submit"]');
        await page.waitForLoadState('networkidle');
        
        // Bỏ qua Verify Email nếu có
        const usePasswordBtn = page.locator('#idA_PWD_SwitchToPassword, a:has-text("Use your password"), a:has-text("Sử dụng mật khẩu của bạn")');
        if (await usePasswordBtn.count() > 0 && await usePasswordBtn.isVisible()) {
            console.log('  Phát hiện màn hình hỏi email khôi phục. Đang tự động bấm "Use your password"...');
            await usePasswordBtn.click();
            await page.waitForLoadState('networkidle');
        }

        const passwordInput = page.locator('input[name="passwd"]');
        await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
        await passwordInput.fill(account.password);
        await page.click('input[type="submit"]');

        await page.waitForLoadState('networkidle');

        // Stay signed in?
        const staySignedInYes = page.locator('#idSIButton9');
        if (await staySignedInYes.count() > 0 && await staySignedInYes.isVisible()) {
            console.log('  Bấm "Yes" để giữ trạng thái đăng nhập...');
            await staySignedInYes.click();
        }

        console.log('  Đang đợi Outlook tải xong...');
        await page.waitForURL(/outlook\.live\.com\/mail/, { timeout: 30000 });
        
        const storageState = await context.storageState();
        account.sessionState = storageState;
        account.lastLoginAt = new Date();
        account.status = 'active';
        await account.save();
        
        console.log(`✅ [THÀNH CÔNG] Đã lưu Cookies cho ${account.email}.`);

    } catch (error) {
        console.error(`❌ [LỖI] Không thể đăng nhập ${account.email}:`, error.message);
        account.status = 'error';
        await account.save();
    } finally {
        await browser.close();
    }
}

// Chức năng: Đọc danh sách từ file accounts.txt
async function importAccountsFromFile() {
    if (!fs.existsSync('accounts.txt')) {
        console.log('❌ File accounts.txt không tồn tại. Vui lòng tạo file và nhập danh sách!');
        return;
    }

    const data = fs.readFileSync('accounts.txt', 'utf-8');
    const lines = data.split('\n').filter(line => line.trim() !== '' && !line.startsWith('#'));
    
    let addedCount = 0;
    for (let line of lines) {
        const [email, password] = line.split('|').map(i => i.trim());
        if (email && password) {
            const exists = await OutlookAccount.findOne({ email });
            if (!exists) {
                await OutlookAccount.create({ email, password });
                addedCount++;
                console.log(`  + Đã thêm: ${email}`);
            }
        }
    }
    console.log(`✅ Đã nhập thành công ${addedCount} tài khoản mới từ file.`);
}

// Chức năng: Chạy Auto Login cho toàn bộ nick chưa có Session
async function runBatchAutoLogin() {
    const accounts = await OutlookAccount.find({ sessionState: { $exists: false } });
    if (accounts.length === 0) {
        console.log('✅ Mọi tài khoản trong DB đều đã có sẵn phiên đăng nhập (Cookies).');
        return;
    }

    console.log(`🚀 Tìm thấy ${accounts.length} tài khoản chưa có Session. Bắt đầu đăng nhập tự động...`);
    for (let i = 0; i < accounts.length; i++) {
        console.log(`\n--- Tài khoản ${i + 1}/${accounts.length} ---`);
        await loginAndGetSession(accounts[i]);
    }
}

// Chức năng: Chọn 1 tài khoản để đọc thư
async function chooseAccountToReadMail() {
    const accounts = await OutlookAccount.find({ sessionState: { $exists: true } });
    
    if (accounts.length === 0) {
        console.log('❌ Chưa có tài khoản nào có Session. Vui lòng chạy "Auto Login" trước!');
        return;
    }

    const choices = accounts.map(acc => ({
        name: acc.email,
        value: acc
    }));

    const answer = await inquirer.prompt([
        {
            type: 'list',
            name: 'selectedAccount',
            message: 'Chọn tài khoản bạn muốn đọc email:',
            choices: choices
        }
    ]);

    const account = answer.selectedAccount;
    console.log(`\nĐang mở hộp thư cho ${account.email} (Chế độ Headless ẩn)...`);
    
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: account.sessionState });
    const page = await context.newPage();

    try {
        await page.goto('https://outlook.live.com/mail/0/inbox');
        await page.waitForSelector('div[aria-label="Message list"]', { timeout: 30000 });
        
        console.log('✅ Đã load xong hộp thư! (Không cần đăng nhập lại)');
        const emails = await page.locator('div[role="listbox"] span[title]').allInnerTexts();
        
        console.log(`\n📬 TÌM THẤY ${emails.length} THÔNG BÁO MỚI:`);
        emails.slice(0, 5).forEach((mail, idx) => console.log(`   ${idx + 1}. ${mail}`));

    } catch (error) {
        console.error('❌ Lỗi khi đọc email (Có thể Session đã hết hạn):', error.message);
    } finally {
        await browser.close();
    }
}

// MENU TƯƠNG TÁC
async function showMenu() {
    console.log('\n======================================');
    console.log('   TOOL QUẢN LÝ AUTO OUTLOOK (CLI)');
    console.log('======================================');
    
    const count = await OutlookAccount.countDocuments();
    const activeSessionCount = await OutlookAccount.countDocuments({ sessionState: { $exists: true } });
    console.log(`Thống kê: Có tổng cộng ${count} tài khoản trong DB (${activeSessionCount} nick đã có Session).`);

    const answer = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Bạn muốn làm gì?',
            choices: [
                { name: '1. Nhập danh sách tài khoản từ file (accounts.txt)', value: 'import' },
                { name: '2. Auto Login (Lấy Cookie cho các nick chưa có)', value: 'login' },
                { name: '3. Chọn tài khoản để đọc thông báo/email', value: 'read' },
                { name: '0. Thoát', value: 'exit' }
            ]
        }
    ]);

    switch (answer.action) {
        case 'import':
            await importAccountsFromFile();
            break;
        case 'login':
            await runBatchAutoLogin();
            break;
        case 'read':
            await chooseAccountToReadMail();
            break;
        case 'exit':
            console.log('Đã thoát chương trình.');
            return false;
    }
    return true; // Tiếp tục hiện menu
}

async function main() {
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/outlook_db';
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Đã kết nối Database.');

    let isRunning = true;
    while (isRunning) {
        isRunning = await showMenu();
    }

    mongoose.disconnect();
}

main();
