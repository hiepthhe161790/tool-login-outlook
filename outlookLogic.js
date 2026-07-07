const { chromium } = require('playwright');
const mongoose = require('mongoose');
const async = require('async');

const OutlookAccountSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    proxy: { type: String }, // Format: ip:port hoặc ip:port:user:pass
    sessionState: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, default: 'pending' }, // pending, active, error
    lastLoginAt: { type: Date }
});

const OutlookAccount = mongoose.models.OutlookAccount || mongoose.model('OutlookAccount', OutlookAccountSchema);

// Cấu hình Hàng Đợi (Queue) với mức độ song song (Concurrency) là 2
// (Chỉ chạy tối đa 2 trình duyệt cùng lúc để tránh treo máy)
const loginQueue = async.queue(async (email) => {
    console.log(`[Queue] Đang xử lý đăng nhập cho: ${email}`);
    await loginAndGetSession(email);
}, 2);

loginQueue.drain(() => {
    console.log('✅ Hàng đợi đã xử lý xong toàn bộ tài khoản!');
});

// Hàm bóc tách chuỗi Proxy (ip:port:user:pass) sang định dạng của Playwright
function parseProxy(proxyStr) {
    if (!proxyStr) return undefined;
    const parts = proxyStr.trim().split(':');
    if (parts.length === 2) {
        return { server: `http://${parts[0]}:${parts[1]}` };
    } else if (parts.length >= 4) {
        return { 
            server: `http://${parts[0]}:${parts[1]}`,
            username: parts[2],
            password: parts.slice(3).join(':') // Đề phòng pass có dấu :
        };
    }
    return undefined;
}

async function loginAndGetSession(email) {
    const account = await OutlookAccount.findOne({ email });
    if (!account) return { success: false, message: 'Account not found' };

    const browser = await chromium.launch({ headless: true }); 
    const proxyConfig = parseProxy(account.proxy);
    const context = await browser.newContext(proxyConfig ? { proxy: proxyConfig } : undefined);
    const page = await context.newPage();

    try {
        console.log(`[${email}] Đang mở trang đăng nhập...`);
        await page.goto('https://login.live.com/');
        console.log(`[${email}] Đã mở trang, đang điền email...`);
        await page.fill('input[type="email"], input[name="loginfmt"]', account.email);
        console.log(`[${email}] Đang bấm nút Tiếp theo (Next)...`);
        await page.click('#idSIButton9, input[type="submit"], button[type="submit"]', { timeout: 5000 }).catch(()=>{});
        
        // Chờ 3 giây để trang thực hiện hiệu ứng chuyển cảnh
        await page.waitForTimeout(3000);

        // Kiểm tra xem có bị lỗi ngay bước nhập Email không (VD: Không tìm thấy tài khoản, hoặc lỗi hệ thống)
        const usernameError = page.locator('#usernameError');
        if (await usernameError.count() > 0 && await usernameError.isVisible()) {
            const errorText = await usernameError.innerText();
            throw new Error(`Lỗi xác minh Email: ${errorText.trim()}`);
        }
        
        // Kiểm tra Verify Email hoặc màn hình chọn "Use your password"
        // Microsoft hay dùng id="idA_PWD_SwitchToPassword"
        const usePasswordBtn = page.locator('#idA_PWD_SwitchToPassword, [id*="SwitchToPassword"], :text-is("Use your password"), :text-is("Sử dụng mật khẩu của bạn")').first();
        if (await usePasswordBtn.count() > 0 && await usePasswordBtn.isVisible()) {
            console.log(`[${email}] Phát hiện hỏi mã khôi phục. Tự động bấm "Use your password"...`);
            await usePasswordBtn.click({ timeout: 5000 }).catch(()=>{});
            await page.waitForTimeout(2000);
        }

        const passwordInput = page.locator('input[name="passwd"]');
        console.log(`[${email}] Đang chờ màn hình nhập mật khẩu...`);
        await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
        await passwordInput.fill(account.password);
        console.log(`[${email}] Đang bấm nút Đăng nhập (Sign in)...`);
        await page.click('#idSIButton9, input[type="submit"], button[type="submit"]', { timeout: 5000 }).catch(()=>{});

        console.log(`[${email}] Đang xử lý các cửa sổ phụ của Microsoft (nếu có)...`);
        
        try {
            const safeName = email.replace(/[@.]/g, '_');
            await page.waitForTimeout(3000); // Đợi 3s cho popup hiện lên rồi mới chụp
            await page.screenshot({ path: `public/popup_${safeName}.png` });
            console.log(`[${email}] 📸 Đã chụp ảnh màn hình Popup tại: public/popup_${safeName}.png`);
        } catch(e) {}
        
        let attempts = 0;
        let isSuccess = false;

        // Lặp tối đa 6 lần (khoảng 24 giây) để xử lý mọi loại popup trung gian
        while (attempts < 6) {
            await page.waitForTimeout(4000); // Chờ giao diện render
            
            if (page.url().includes('mail')) {
                isSuccess = true;
                break;
            }

            // Kiểm tra xem có bị sai mật khẩu hoặc tài khoản bị khóa không
            const errorMsg = page.locator('#passwordError, #loginHeader:has-text("locked"), .alert-error');
            if (await errorMsg.count() > 0 && await errorMsg.isVisible()) {
                throw new Error('Sai mật khẩu hoặc Tài khoản bị khóa.');
            }

            // Kiểm tra màn hình Checkpoint (Yêu cầu nhận mã về Email khôi phục)
            const proofInput = page.locator('input[name="ProofConfirmation"], #iProofEmail, :text-is("Verify your email")');
            if (await proofInput.count() > 0 && await proofInput.isVisible()) {
                throw new Error('Tài khoản bị Checkpoint - Yêu cầu xác minh bằng Email khôi phục.');
            }

            const primaryBtn = page.locator('#idSIButton9, button:has-text("Yes"), button:has-text("OK"), button:has-text("Continue"), input[value="OK"]').first();
            const skipBtn = page.locator('#idBtn_Back, a#iCancel, a:has-text("Skip"), button:has-text("Cancel")').first();

            // Nhận diện màn hình Stay Signed In (Có cả Yes và No) hoặc Privacy Notice
            if (await primaryBtn.count() > 0 && await primaryBtn.isVisible()) {
                console.log(`[${email}] Đã thấy nút Đồng ý/Yes. Đăng nhập THÀNH CÔNG! Đang lấy Session...`);
                // Bấm nút bằng Playwright click có timeout 3s (Nếu bị kẹt Navigation sẽ tự thoát ra sau 3s)
                await primaryBtn.click({ timeout: 3000 }).catch(()=>{});
                isSuccess = true;
                break;
            } else if (await skipBtn.count() > 0 && await skipBtn.isVisible()) {
                console.log(`[${email}] Đã thấy nút Bỏ qua/Cancel. Đăng nhập THÀNH CÔNG! Đang lấy Session...`);
                await skipBtn.click({ timeout: 3000 }).catch(()=>{});
                isSuccess = true;
                break;
            }

            attempts++;
        }

        if (!isSuccess) {
            console.log(`[${email}] Đang cố gắng đợi thêm chút để lấy URL đích...`);
            try {
                await page.waitForURL(/outlook\.live\.com\/mail/, { timeout: 10000 });
                isSuccess = true;
            } catch (urlError) {
                console.log(`[${email}] ⚠️ Vẫn chưa vào được Mail. URL hiện tại: ${page.url()}`);
                throw new Error('Timeout không vào được hộp thư (Có thể bị kẹt ở popup chưa biết).');
            }
        }
        
        // Chỉ cần tới đây là đã có đủ Cookie Authentication của Microsoft
        const storageState = await context.storageState();
        account.sessionState = storageState;
        account.lastLoginAt = new Date();
        account.status = 'active';
        await account.save();
        console.log(`[${email}] ✅ Đăng nhập thành công!`);
        return { success: true, message: `Login thành công ${email}` };
    } catch (error) {
        console.error(`[${email}] ❌ Lỗi:`, error.message);
        try {
            // Chụp ảnh màn hình lúc bị lỗi để xem Microsoft đang hiển thị cái gì
            const safeName = email.replace(/[@.]/g, '_');
            await page.screenshot({ path: `public/error_${safeName}.png` });
            console.log(`[${email}] 📸 Đã chụp ảnh màn hình lỗi tại: public/error_${safeName}.png`);
        } catch(e) {}
        
        account.status = 'error';
        await account.save();
        return { success: false, message: error.message };
    } finally {
        await browser.close();
    }
}

async function getMails(email) {
    const account = await OutlookAccount.findOne({ email });
    if (!account || !account.sessionState) {
        throw new Error('Tài khoản chưa có Session. Vui lòng bấm Auto Login trước.');
    }
    
    const browser = await chromium.launch({ headless: true });
    
    const contextOptions = { storageState: account.sessionState };
    const proxyConfig = parseProxy(account.proxy);
    if (proxyConfig) contextOptions.proxy = proxyConfig;
    
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
        await page.goto('https://outlook.live.com/mail/0/inbox');
        
        // Hỗ trợ cả giao diện Tiếng Anh và Tiếng Việt
        const messageList = page.locator('div[aria-label="Message list"] div[role="option"], div[aria-label="Danh sách thư"] div[role="option"]');
        await messageList.first().waitFor({ state: 'visible', timeout: 30000 });
        
        const rawTexts = await messageList.allInnerTexts();
        
        // Trích xuất 10 thư gần nhất
        const recentEmails = rawTexts.slice(0, 10).map(text => {
            // Tách các dòng text (Người gửi, Tiêu đề, Preview, Thời gian)
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            // Lọc bỏ các từ rác hệ thống (Chưa đọc, Đã chọn...)
            const cleanLines = lines.filter(l => !['Unread', 'Chưa đọc', 'Selected', 'Đã chọn'].includes(l));
            
            // Nối lại bằng dấu | để dễ đọc OTP
            return cleanLines.join(' | ');
        });
        
        return recentEmails;
    } catch (error) {
        throw new Error('Lỗi load hộp thư. Có thể Microsoft đã thu hồi phiên làm việc, hãy thử Auto Login lại.');
    } finally {
        await browser.close();
    }
}

// Thêm hàm để đẩy tài khoản vào hàng đợi
function addAccountsToQueue(emails) {
    emails.forEach(email => {
        loginQueue.push(email, (err) => {
            if (err) console.error(`[Lỗi Queue] ${email}:`, err);
        });
    });
}

function getQueueStatus() {
    return {
        waiting: loginQueue.length(),
        running: loginQueue.running()
    };
}

module.exports = {
    OutlookAccount,
    loginAndGetSession,
    getMails,
    addAccountsToQueue,
    getQueueStatus
};
