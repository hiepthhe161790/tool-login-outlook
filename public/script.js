let allAccounts = [];
let selectedEmails = new Set();

document.addEventListener('DOMContentLoaded', () => {
    fetchAccounts();

    document.getElementById('addBulkBtn').addEventListener('click', addBulkAccounts);
    document.getElementById('runQueueBtn').addEventListener('click', startQueue);
    document.getElementById('deleteSelectedBtn').addEventListener('click', deleteSelected);
    document.getElementById('exportBtn').addEventListener('click', exportAccounts);
    
    document.getElementById('searchEmail').addEventListener('input', applyFilter);
    document.getElementById('filterStatus').addEventListener('change', applyFilter);
    document.getElementById('selectAll').addEventListener('change', toggleSelectAll);

    document.getElementById('openAddModalBtn').addEventListener('click', () => {
        document.getElementById('addAccountModal').classList.add('active');
    });
    document.getElementById('closeAddModal').addEventListener('click', () => {
        document.getElementById('addAccountModal').classList.remove('active');
    });

    document.getElementById('closeModal').addEventListener('click', () => {
        document.getElementById('emailModal').classList.remove('active');
    });

    // Check hàng đợi mỗi 3s
    setInterval(checkQueueStatus, 3000);
});

async function fetchAccounts() {
    try {
        const res = await fetch('/api/accounts');
        allAccounts = await res.json();
        applyFilter();
        updateStats(allAccounts);
    } catch (err) {
        console.error('Lỗi load danh sách', err);
    }
}

function updateStats(accounts) {
    document.getElementById('totalAcc').textContent = accounts.length;
    const active = accounts.filter(a => a.status === 'active').length;
    document.getElementById('activeAcc').textContent = active;
}

async function checkQueueStatus() {
    try {
        const res = await fetch('/api/queue-status');
        const data = await res.json();
        
        const qBox = document.getElementById('queueStatusBox');
        if (data.running > 0 || data.waiting > 0) {
            qBox.style.display = 'block';
            document.getElementById('queueRunning').textContent = data.running;
            document.getElementById('queueWaiting').textContent = data.waiting;
            fetchAccounts(); // Tự update lại bảng nếu đang có tiến trình chạy
        } else {
            qBox.style.display = 'none';
        }
    } catch (e) {}
}

function applyFilter() {
    const searchText = document.getElementById('searchEmail').value.toLowerCase();
    const statusVal = document.getElementById('filterStatus').value;
    
    const filtered = allAccounts.filter(acc => {
        const matchSearch = acc.email.toLowerCase().includes(searchText);
        const matchStatus = statusVal === 'all' || acc.status === statusVal;
        return matchSearch && matchStatus;
    });
    
    renderTable(filtered);
    updateDeleteBtnState();
}

function renderTable(accounts) {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    // Cập nhật trạng thái Checkbox All
    const selectAllCb = document.getElementById('selectAll');
    selectAllCb.checked = accounts.length > 0 && accounts.every(a => selectedEmails.has(a.email));

    accounts.forEach(acc => {
        const tr = document.createElement('tr');
        const isChecked = selectedEmails.has(acc.email);
        
        let statusBadge = '';
        if (acc.status === 'active') statusBadge = '<span class="badge active">Đã có Session</span>';
        else if (acc.status === 'error') statusBadge = '<span class="badge error">Lỗi Đăng nhập</span>';
        else statusBadge = '<span class="badge pending">Chờ chạy ngầm</span>';

        const date = acc.lastLoginAt ? new Date(acc.lastLoginAt).toLocaleString('vi-VN') : '-';

        tr.innerHTML = `
            <td style="text-align: center;">
                <input type="checkbox" class="row-cb" value="${acc.email}" ${isChecked ? 'checked' : ''} onchange="toggleSelectRow(this)">
            </td>
            <td><strong>${acc.email}</strong></td>
            <td style="color: var(--text-secondary); font-size: 0.85rem">${acc.proxy || '-'}</td>
            <td>${statusBadge}</td>
            <td style="color: var(--text-secondary); font-size: 0.85rem">${date}</td>
            <td class="actions" style="display: flex; gap: 5px;">
                <button class="btn small primary" ${acc.status !== 'active' ? 'disabled style="opacity:0.5"' : ''} onclick="readMails('${acc.email}')">Đọc Thư</button>
                <button class="btn small outline" onclick="triggerLogin('${acc.email}', this)">Đăng nhập</button>
                <button class="btn small outline" style="border-color: #f59e0b; color: #f59e0b" onclick="editAccount('${acc.email}')">Sửa</button>
                <button class="btn small outline" style="border-color: #ef4444; color: #ef4444" onclick="deleteAccount('${acc.email}')">Xóa</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function toggleSelectRow(cb) {
    if (cb.checked) selectedEmails.add(cb.value);
    else selectedEmails.delete(cb.value);
    updateDeleteBtnState();
    
    const visibleCbs = Array.from(document.querySelectorAll('.row-cb'));
    document.getElementById('selectAll').checked = visibleCbs.every(c => c.checked) && visibleCbs.length > 0;
}

function toggleSelectAll(e) {
    const isChecked = e.target.checked;
    const visibleCbs = document.querySelectorAll('.row-cb');
    visibleCbs.forEach(cb => {
        cb.checked = isChecked;
        if (isChecked) selectedEmails.add(cb.value);
        else selectedEmails.delete(cb.value);
    });
    updateDeleteBtnState();
}

function updateDeleteBtnState() {
    const btn = document.getElementById('deleteSelectedBtn');
    if (selectedEmails.size > 0) {
        btn.style.display = 'inline-block';
        btn.textContent = `🗑️ Xóa (${selectedEmails.size})`;
    } else {
        btn.style.display = 'none';
    }
}

async function deleteAccount(email) {
    if (!confirm(`Bạn có chắc muốn xóa tài khoản ${email}?`)) return;
    try {
        const res = await fetch(`/api/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' });
        await res.json();
        selectedEmails.delete(email);
        fetchAccounts();
    } catch(e) {}
}

async function deleteSelected() {
    if (!confirm(`Bạn có chắc muốn xóa ${selectedEmails.size} tài khoản đã chọn?`)) return;
    try {
        const res = await fetch('/api/accounts/delete-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emails: Array.from(selectedEmails) })
        });
        await res.json();
        selectedEmails.clear();
        fetchAccounts();
    } catch(e) {}
}

async function exportAccounts() {
    let emailsToExport = [];
    if (selectedEmails.size > 0) {
        emailsToExport = Array.from(selectedEmails);
    } else {
        const searchText = document.getElementById('searchEmail').value.toLowerCase();
        const statusVal = document.getElementById('filterStatus').value;
        const filtered = allAccounts.filter(acc => {
            const matchSearch = acc.email.toLowerCase().includes(searchText);
            const matchStatus = statusVal === 'all' || acc.status === statusVal;
            return matchSearch && matchStatus;
        });
        emailsToExport = filtered.map(a => a.email);
    }
    
    if (emailsToExport.length === 0) return alert('Không có tài khoản nào để xuất.');

    try {
        const res = await fetch('/api/accounts/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emails: emailsToExport })
        });
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `accounts_export_${new Date().getTime()}.txt`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
    } catch(e) {
        alert('Lỗi xuất file!');
    }
}

async function editAccount(email) {
    const newPass = prompt(`Sửa thông tin cho ${email}:\n(Điền mật khẩu mới, hoặc để trống nếu chỉ muốn Đặt lại trạng thái về Chờ chạy ngầm)`);
    if (newPass === null) return; // Hủy
    
    try {
        const res = await fetch(`/api/accounts/${encodeURIComponent(email)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: newPass.trim() })
        });
        const data = await res.json();
        alert(data.message);
        fetchAccounts();
    } catch(e) {}
}

// Bóc tách dữ liệu dán vào textarea
async function addBulkAccounts() {
    const text = document.getElementById('bulkInput').value.trim();
    if (!text) return alert('Vui lòng dán danh sách tài khoản!');

    // Cắt theo từng dòng
    const lines = text.split('\n');
    const parsedAccounts = [];

    lines.forEach(line => {
        const clean = line.trim();
        if (!clean) return;
        
        // Phân tách bằng dấu | HOẶC \t (tab) HOẶC khoảng trắng
        const parts = clean.split(/\||\s+/); 
        
        if (parts.length >= 2) {
            const email = parts[0].trim();
            const password = parts[1].trim();
            const proxy = parts[2] ? parts[2].trim() : undefined;
            if (email.includes('@')) {
                parsedAccounts.push({ email, password, proxy });
            }
        }
    });

    if (parsedAccounts.length === 0) {
        return alert('Không tìm thấy định dạng hợp lệ. Hãy dùng: email|pass hoặc email pass');
    }

    const btn = document.getElementById('addBulkBtn');
    btn.textContent = 'Đang lưu...';

    try {
        const res = await fetch('/api/accounts/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accounts: parsedAccounts })
        });
        const data = await res.json();
        alert(data.message);
        document.getElementById('bulkInput').value = '';
        document.getElementById('addAccountModal').classList.remove('active');
        fetchAccounts();
    } catch (e) {
        alert('Lỗi khi lưu danh sách!');
    } finally {
        btn.textContent = 'Nhập Danh Sách';
    }
}

async function startQueue() {
    const btn = document.getElementById('runQueueBtn');
    btn.disabled = true;
    try {
        // Gửi danh sách các email đang được tick chọn (nếu có)
        const bodyData = selectedEmails.size > 0 ? { emails: Array.from(selectedEmails) } : {};
        
        const res = await fetch('/api/accounts/auto-login-all', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });
        const data = await res.json();
        alert(data.message);
        checkQueueStatus();
    } catch(e) {
        alert('Lỗi kích hoạt hàng đợi');
    } finally {
        btn.disabled = false;
    }
}

async function triggerLogin(email, btnElement) {
    btnElement.textContent = 'Đang chạy...';
    btnElement.disabled = true;
    try {
        const res = await fetch(`/api/accounts/${encodeURIComponent(email)}/login`, { method: 'POST' });
        const data = await res.json();
        alert(data.success ? data.message : 'Lỗi: ' + data.message);
        fetchAccounts();
    } catch (e) {
        alert('Có lỗi xảy ra.');
    }
}

async function readMails(email) {
    const modal = document.getElementById('emailModal');
    const loading = document.getElementById('loadingMails');
    const list = document.getElementById('mailList');
    
    document.getElementById('modalTitle').textContent = `Hộp thư: ${email}`;
    list.style.display = 'none';
    loading.style.display = 'block';
    modal.classList.add('active');

    try {
        const res = await fetch(`/api/accounts/${encodeURIComponent(email)}/mails`);
        const data = await res.json();
        
        if (data.success) {
            list.innerHTML = '';
            if (data.mails.length === 0) list.innerHTML = '<li>Không có thư nào trên màn hình.</li>';
            else data.mails.forEach(m => {
                const li = document.createElement('li');
                
                // Trích xuất mã OTP bằng Regex (Bắt các chuỗi 6-8 chữ số độc lập)
                let otpMatch = m.match(/\b\d{6,8}\b/);
                let otpHtml = '';
                if (otpMatch) {
                    otpHtml = `
                    <div style="margin-top: 8px; display: flex; align-items: center; gap: 10px;">
                        <strong style="color: #ef4444; font-size: 1.1rem; background: rgba(239, 68, 68, 0.1); padding: 4px 8px; border-radius: 4px;">Mã OTP: ${otpMatch[0]}</strong>
                        <button class="btn small outline" onclick="navigator.clipboard.writeText('${otpMatch[0]}'); this.textContent='Đã Copy!';" style="padding: 4px 8px; font-size: 0.8rem;">Copy</button>
                    </div>`;
                }

                li.innerHTML = `<div style="color: var(--text-primary); font-size: 0.9rem; line-height: 1.4;">${m}</div>${otpHtml}`;
                list.appendChild(li);
            });
            loading.style.display = 'none';
            list.style.display = 'block';
        } else {
            loading.textContent = 'Lỗi: ' + data.message;
        }
    } catch (e) {
        loading.textContent = 'Lỗi Server!';
    }
}
