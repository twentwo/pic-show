// 阻止 release 构建时弹出额外的控制台窗口（仅 Windows 生效）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    picshow_lib::run()
}
