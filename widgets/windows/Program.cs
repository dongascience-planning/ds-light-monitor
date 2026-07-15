using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DsStatusWidget
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool createdNew;
            using (var mutex = new Mutex(true, "DsStatusWidget_SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show(
                        "이미 실행 중입니다.\n\n작업표시줄 오른쪽(시계 옆 또는 ∧ 안)의 얼굴 아이콘을 클릭하면 상태가 보입니다.",
                        "DS 상태 위젯", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                bool quiet = false; // 부팅 자동 시작이면 실행 알림 생략
                foreach (string a in args) if (a == "--autostart") quiet = true;
                // TLS 1.2 이상만 허용 (12288 = Tls13, 구형 런타임이면 1.2만)
                try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; }
                catch (NotSupportedException) { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                try
                {
                    Application.Run(new TrayContext(quiet));
                }
                catch (Exception ex)
                {
                    MessageBox.Show(
                        "위젯 실행 중 오류가 발생했습니다.\n\n[" + ex.GetType().Name + "] " + ex.Message,
                        "DS 상태 위젯", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }
    }

    class ServiceStat
    {
        public string Key;
        public string Name;
        public bool Ok;
        public bool Slow;
        public bool ImgBroken;
        public int Elapsed;
    }

    class Snapshot
    {
        public DateTimeOffset Ts;
        public List<ServiceStat> Services = new List<ServiceStat>();
    }

    class StateResult
    {
        public int Level; // 0 정상 / 1 주의(느림·이미지·이력지연) / 2 장애
        public bool Stale;
        public Snapshot Latest;
        public Dictionary<string, double> Uptime24h = new Dictionary<string, double>();
    }

    class FetchResult
    {
        public List<Snapshot> Snaps;
        public string Error;
    }

    class TrayContext : ApplicationContext
    {
        [DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr handle);

        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunName = "DsStatusWidget";
        const int PollSeconds = 300; // 데이터 자체가 30분 주기라 5분이면 충분
        internal const string DataUrl = "https://raw.githubusercontent.com/dongascience-planning/ds-light-monitor/main/docs/data/history-light.json";
        const string DashboardUrl = "https://dongascience-planning.github.io/ds-monitor/";
        internal static readonly string[] ServiceKeys = { "dsstore", "dotcom", "dl" };
        internal static readonly string[] ServiceNames = { "DS스토어", "동아사이언스 닷컴", "d라이브러리" };

        static readonly HttpClient Http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });

        NotifyIcon tray;
        DetailForm detail;
        System.Windows.Forms.Timer timer;
        System.Windows.Forms.Timer uiTimer; // 툴팁 "n분 전" 표시만 1분마다 재계산 (네트워크 조회 없음)
        string tipBase; // 서비스 요약 부분 (점검 시각 제외)
        DateTimeOffset tipCheckedAt = DateTimeOffset.MinValue;
        ToolStripMenuItem autoStartItem;
        volatile bool fetching;
        bool exiting;
        readonly Dictionary<string, bool> lastOk = new Dictionary<string, bool>(); // 장애/복구 전이 알림용

        public TrayContext(bool quiet)
        {
            Http.Timeout = TimeSpan.FromSeconds(20);

            detail = new DetailForm();
            detail.OnRefresh = delegate { RefreshUsage(); };
            detail.OnOpenDashboard = delegate { OpenDashboard(); };
            IntPtr forceHandle = detail.Handle; // BeginInvoke를 쓰려면 핸들이 먼저 생성돼 있어야 함

            var menu = new ContextMenuStrip();
            var refreshItem = new ToolStripMenuItem("지금 새로고침");
            refreshItem.Click += delegate { RefreshUsage(); };
            var dashItem = new ToolStripMenuItem("대시보드 열기");
            dashItem.Click += delegate { OpenDashboard(); };
            autoStartItem = new ToolStripMenuItem("로그인 시 자동 시작");
            autoStartItem.Checked = IsAutoStart();
            autoStartItem.Click += delegate { SetAutoStart(!autoStartItem.Checked); autoStartItem.Checked = IsAutoStart(); };
            var exitItem = new ToolStripMenuItem("종료");
            exitItem.Click += delegate { ExitApp(); };
            menu.Items.Add(refreshItem);
            menu.Items.Add(dashItem);
            menu.Items.Add(autoStartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            tray = new NotifyIcon();
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            tray.Text = "DS 서비스 상태 불러오는 중...";
            SetTrayIcon(3); // 회색 경광등 = 데이터 없음
            tray.MouseUp += delegate(object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left)
                {
                    if (detail.Visible) detail.Hide();
                    else { detail.ShowNearTray(); RefreshUsage(); }
                }
            };

            timer = new System.Windows.Forms.Timer();
            timer.Interval = PollSeconds * 1000;
            timer.Tick += delegate { RefreshUsage(); };
            timer.Start();

            uiTimer = new System.Windows.Forms.Timer();
            uiTimer.Interval = 60 * 1000;
            uiTimer.Tick += delegate { UpdateTooltip(); if (detail.Visible) detail.Invalidate(); };
            uiTimer.Start();

            RefreshUsage();

            if (!quiet)
                tray.ShowBalloonTip(4000, "DS 상태 위젯 실행됨",
                    "작업표시줄 오른쪽(시계 옆 또는 ∧ 안)의 얼굴 아이콘을 클릭하면 서비스 상태가 보입니다.", ToolTipIcon.Info);
        }

        void OpenDashboard()
        {
            try { Process.Start(DashboardUrl); } // 고정 URL만 연다 (외부 입력 아님)
            catch (Exception) { }
        }

        void ExitApp()
        {
            exiting = true;
            timer.Stop();
            timer.Dispose();
            uiTimer.Stop();
            uiTimer.Dispose();
            tray.Visible = false;
            tray.Dispose();
            Application.Exit();
        }

        bool IsAutoStart()
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKey))
                    return k != null && k.GetValue(RunName) != null;
            }
            catch (Exception) { return false; }
        }

        void SetAutoStart(bool on)
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKey, true))
                {
                    if (k == null) return;
                    if (on) k.SetValue(RunName, "\"" + Application.ExecutablePath + "\" --autostart");
                    else k.DeleteValue(RunName, false);
                }
            }
            catch (Exception)
            {
                MessageBox.Show("자동 시작 설정을 변경할 수 없습니다 (레지스트리 접근 제한).", "DS 상태 위젯", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        void RefreshUsage()
        {
            if (fetching) return;
            fetching = true;
            Task.Run((Func<FetchResult>)FetchOnce).ContinueWith(delegate(Task<FetchResult> t)
            {
                var res = t.IsFaulted ? new FetchResult { Error = "알 수 없는 오류" } : t.Result;
                try
                {
                    detail.BeginInvoke((Action)delegate
                    {
                        // try/finally 필수: ApplyResult가 예외를 던지면 fetching이 영구 true로 남아 갱신이 멈춤
                        try { if (!exiting) ApplyResult(res); }
                        catch (Exception) { }
                        finally { fetching = false; }
                    });
                }
                catch (Exception) { fetching = false; }
            });
        }

        static FetchResult FetchOnce()
        {
            var r = new FetchResult();
            HttpResponseMessage resp;
            string body;
            try
            {
                // raw.githubusercontent 캐시(약 5분) 회피용 쿼리스트링
                var req = new HttpRequestMessage(HttpMethod.Get, DataUrl + "?t=" + DateTime.UtcNow.Ticks);
                resp = Http.SendAsync(req).Result;
                body = resp.Content.ReadAsStringAsync().Result;
            }
            catch (Exception)
            {
                r.Error = "네트워크 오류 — 연결을 확인하세요";
                return r;
            }
            if (!resp.IsSuccessStatusCode)
            {
                r.Error = "데이터 조회 실패 (HTTP " + (int)resp.StatusCode + ")";
                return r;
            }
            try
            {
                r.Snaps = ParseHistory(body);
                if (r.Snaps.Count == 0) r.Error = "점검 이력이 비어 있음";
            }
            catch (Exception)
            {
                r.Error = "응답 해석 실패";
            }
            return r;
        }

        // 이력 JSON 파싱 — 항목 단위 방어 (오염 항목은 버리고 나머지 유지). 테스트용 internal
        internal static List<Snapshot> ParseHistory(string body)
        {
            var list = new List<Snapshot>();
            var jss = new JavaScriptSerializer();
            jss.MaxJsonLength = 8000000;
            var arr = jss.DeserializeObject(body) as object[];
            if (arr == null) return list;
            foreach (object o in arr)
            {
                var d = o as Dictionary<string, object>;
                if (d == null) continue;
                try
                {
                    var snap = new Snapshot();
                    string ts = d.ContainsKey("ts") ? d["ts"] as string : null;
                    DateTimeOffset t;
                    if (ts == null || !DateTimeOffset.TryParse(ts, CultureInfo.InvariantCulture, DateTimeStyles.None, out t)) continue;
                    snap.Ts = t;
                    for (int i = 0; i < ServiceKeys.Length; i++)
                    {
                        object so;
                        if (!d.TryGetValue(ServiceKeys[i], out so)) continue;
                        var sd = so as Dictionary<string, object>;
                        if (sd == null) continue;
                        var st = new ServiceStat();
                        st.Key = ServiceKeys[i];
                        st.Name = ServiceNames[i];
                        st.Ok = sd.ContainsKey("ok") && sd["ok"] is bool && (bool)sd["ok"];
                        st.Slow = sd.ContainsKey("slow") && sd["slow"] is bool && (bool)sd["slow"];
                        st.ImgBroken = sd.ContainsKey("imgBroken") && sd["imgBroken"] is bool && (bool)sd["imgBroken"];
                        st.Elapsed = sd.ContainsKey("elapsed") && sd["elapsed"] != null ? Convert.ToInt32(sd["elapsed"]) : 0;
                        snap.Services.Add(st);
                    }
                    if (snap.Services.Count > 0) list.Add(snap);
                }
                catch (Exception) { }
            }
            return list;
        }

        // 최신 스냅샷 기준 상태 판정 + 24시간 가동률. 순서가 뒤섞인 배열도 ts 최댓값으로 최신을 고른다. 테스트용 internal
        internal static StateResult ComputeState(List<Snapshot> snaps, DateTimeOffset now)
        {
            if (snaps == null || snaps.Count == 0) return null;
            var latest = snaps[0];
            foreach (var s in snaps) if (s.Ts > latest.Ts) latest = s;

            var r = new StateResult();
            r.Latest = latest;
            r.Stale = (now - latest.Ts).TotalMinutes > 90; // 30분 주기 × 3회 연속 누락이면 지연으로 판정

            int level = 0;
            foreach (var svc in latest.Services)
            {
                if (!svc.Ok) level = 2;
                else if ((svc.Slow || svc.ImgBroken) && level < 1) level = 1;
            }
            if (r.Stale && level < 1) level = 1;
            r.Level = level;

            foreach (string key in ServiceKeys)
            {
                int total = 0, okCount = 0;
                foreach (var s in snaps)
                {
                    if ((now - s.Ts).TotalHours > 24) continue;
                    foreach (var svc in s.Services)
                        if (svc.Key == key) { total++; if (svc.Ok) okCount++; break; }
                }
                r.Uptime24h[key] = total > 0 ? 100.0 * okCount / total : -1;
            }
            return r;
        }

        void ApplyResult(FetchResult res)
        {
            detail.LastUpdate = DateTime.Now;

            if (res.Error != null && (res.Snaps == null || res.Snaps.Count == 0))
            {
                detail.Error = res.Error;
                if (detail.State != null)
                {
                    // 일시 조회 실패 — 직전 상태가 있으면 아이콘 유지 (회색 깜빡임 방지)
                    ApplyIcon(detail.State);
                    tray.Text = Clip63("일시 오류 — 마지막 상태 표시 중");
                }
                else
                {
                    SetTrayIcon(3);
                    tray.Text = Clip63("DS 상태: " + res.Error);
                }
                if (detail.Visible) detail.RelayoutAndRepaint();
                return;
            }

            var state = ComputeState(res.Snaps, DateTimeOffset.Now);
            detail.State = state;
            detail.Error = state != null && state.Stale
                ? "점검 이력 지연 — 마지막 점검 " + (int)(DateTimeOffset.Now - state.Latest.Ts).TotalMinutes + "분 전"
                : null;
            if (detail.Visible) detail.RelayoutAndRepaint();
            if (state == null) return;

            ApplyIcon(state);

            var tip = new System.Text.StringBuilder();
            foreach (var svc in state.Latest.Services)
            {
                if (tip.Length > 0) tip.Append(" · ");
                tip.Append(ShortName(svc.Key)).Append(" ").Append(svc.Ok ? (svc.Elapsed / 1000.0).ToString("0.0") + "s" : "장애");
            }
            tipBase = tip.ToString();
            tipCheckedAt = state.Latest.Ts;
            UpdateTooltip();

            // 서비스별 장애/복구 전이 알림 (같은 상태 반복 알림 없음)
            foreach (var svc in state.Latest.Services)
            {
                bool prev;
                if (lastOk.TryGetValue(svc.Key, out prev))
                {
                    if (prev && !svc.Ok)
                        tray.ShowBalloonTip(5000, "DS 서비스 장애 감지", svc.Name + " 접속 실패가 감지됐습니다. 대시보드를 확인하세요.", ToolTipIcon.Error);
                    else if (!prev && svc.Ok)
                        tray.ShowBalloonTip(4000, "DS 서비스 복구", svc.Name + "이(가) 정상으로 돌아왔습니다.", ToolTipIcon.Info);
                }
                lastOk[svc.Key] = svc.Ok;
            }
        }

        void UpdateTooltip()
        {
            if (tipBase == null || tipCheckedAt == DateTimeOffset.MinValue) return;
            tray.Text = Clip63(tipBase + " · " + FmtTipTime(tipCheckedAt, DateTimeOffset.Now));
        }

        void ApplyIcon(StateResult state)
        {
            SetTrayIcon(state.Level);
        }

        // 툴팁용 최근 점검 시각 표시 ("21:44 점검(12분 전)"). 테스트용으로 now 주입 가능
        internal static string FmtTipTime(DateTimeOffset dt, DateTimeOffset now)
        {
            var local = dt.ToLocalTime();
            int mins = (int)(now - dt).TotalMinutes;
            string ago = mins < 1 ? "방금" : mins < 60 ? mins + "분 전" : (mins / 60) + "시간 전";
            return local.ToString("HH:mm") + " 점검(" + ago + ")";
        }

        internal static string ShortName(string key)
        {
            if (key == "dsstore") return "DS";
            if (key == "dotcom") return "닷컴";
            if (key == "dl") return "dl";
            return key;
        }

        internal static string Clip63(string s)
        {
            if (s.Length <= 63) return s;
            int cut = 60;
            if (char.IsHighSurrogate(s[cut - 1])) cut--;
            return s.Substring(0, cut) + "...";
        }

        // 경광등 아이콘: state 0 정상(초록, 꺼짐) / 1 주의(주황+빛살) / 2 장애(빨강+빛살) / 3 데이터 없음(회색)
        // 사용량 위젯(동그란 얼굴)과 완전히 다른 실루엣이라 트레이에서 즉시 구분됨
        internal static Bitmap RenderBeacon(int state)
        {
            return RenderBeacon(state, Color.FromArgb(24, 25, 28), Color.FromArgb(110, 113, 120));
        }

        internal static Bitmap RenderBeacon(int state, Color boxFill, Color boxEdge)
        {
            Color c = state == 0 ? Color.FromArgb(76, 200, 110)
                    : state == 1 ? Color.FromArgb(255, 170, 40)
                    : state == 2 ? Color.FromArgb(240, 70, 85)
                    : Color.FromArgb(150, 150, 150);
            bool alarm = state == 1 || state == 2;

            var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);

                // 네모 배경 — 작은 트레이 크기에서 경광등이 또렷하게 보이도록
                using (var box = RoundedRectPath(new RectangleF(0.5f, 0.5f, 31f, 31f), 7f))
                {
                    using (var wb = new SolidBrush(boxFill))
                        g.FillPath(wb, box);
                    using (var wp = new Pen(boxEdge, 1f))
                        g.DrawPath(wp, box);
                }

                // 돔 (윗반원) — 박스에 최대한 꽉 차게
                if (alarm)
                    using (var glow = new SolidBrush(Color.FromArgb(60, c)))
                        g.FillPie(glow, 3.5f, 4f, 25f, 42f, 180f, 180f);
                using (var b = new SolidBrush(c))
                    g.FillPie(b, 5.5f, 6f, 21f, 38f, 180f, 180f);
                using (var hl = new SolidBrush(Color.FromArgb(120, 255, 255, 255)))
                    g.FillEllipse(hl, 10f, 10.5f, 5f, 7f); // 유리 하이라이트

                // 받침대
                using (var body = RoundedRectPath(new RectangleF(3.5f, 25f, 25f, 5.5f), 2.5f))
                {
                    using (var bb = new SolidBrush(Color.FromArgb(88, 91, 98)))
                        g.FillPath(bb, body);
                }

                // 빛살 — 주의·장애일 때만 ("울리고 있다"는 신호)
                if (alarm)
                {
                    using (var rp = new Pen(c, 2.2f))
                    {
                        rp.StartCap = LineCap.Round;
                        rp.EndCap = LineCap.Round;
                        g.DrawLine(rp, 16f, 4.5f, 16f, 2f);
                        g.DrawLine(rp, 6.5f, 7f, 4.5f, 5f);
                        g.DrawLine(rp, 25.5f, 7f, 27.5f, 5f);
                    }
                }
            }
            return bmp;
        }

        static GraphicsPath RoundedRectPath(RectangleF r, float radius)
        {
            var path = new GraphicsPath();
            float d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        void SetTrayIcon(int state)
        {
            try
            {
                Icon newIcon;
                using (var bmp = RenderBeacon(state))
                {
                    IntPtr h = bmp.GetHicon();
                    try { newIcon = (Icon)Icon.FromHandle(h).Clone(); }
                    finally { DestroyIcon(h); }
                }
                var old = tray.Icon;
                tray.Icon = newIcon;
                if (old != null) old.Dispose();
            }
            catch (Exception) { } // GDI 리소스 고갈 등 — 기존 아이콘 유지가 크래시보다 낫다
        }
    }

    class DetailForm : Form
    {
        public StateResult State;
        public string Error;
        public DateTime LastUpdate;
        public Action OnRefresh;
        public Action OnOpenDashboard;

        LinkLabel refreshLink;
        LinkLabel dashLink;

        const int W = 330;
        const int HeaderH = 46;
        const int RowH = 66;
        const int FooterH = 34;
        int errBoxH;

        public DetailForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(30, 31, 34);
            Width = W;
            Height = HeaderH + RowH + FooterH;
            DoubleBuffered = true;
            KeyPreview = true;

            refreshLink = MakeLink("새로고침");
            refreshLink.Click += delegate { if (OnRefresh != null) OnRefresh(); };
            Controls.Add(refreshLink);

            dashLink = MakeLink("대시보드");
            dashLink.Click += delegate { if (OnOpenDashboard != null) OnOpenDashboard(); };
            Controls.Add(dashLink);
        }

        static LinkLabel MakeLink(string text)
        {
            var l = new LinkLabel();
            l.Text = text;
            l.AutoSize = true;
            l.Font = new Font("맑은 고딕", 8.5f);
            l.BackColor = Color.FromArgb(30, 31, 34);
            l.LinkColor = Color.FromArgb(125, 170, 255);
            l.ActiveLinkColor = Color.White;
            l.LinkBehavior = LinkBehavior.HoverUnderline;
            return l;
        }

        protected override void OnDeactivate(EventArgs e) { base.OnDeactivate(e); Hide(); }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape) Hide();
        }

        public void ShowNearTray()
        {
            Relayout();
            var wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Right - Width - 12, wa.Bottom - Height - 12);
            Show();
            Activate();
        }

        public void RelayoutAndRepaint()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            Relayout();
            Location = new Point(wa.Right - Width - 12, wa.Bottom - Height - 12);
            Invalidate();
        }

        void Relayout()
        {
            if (Error != null)
            {
                using (var f = new Font("맑은 고딕", 7.5f))
                {
                    var sz = TextRenderer.MeasureText(GuideFor(Error), f, new Size(W - 42, 500), TextFormatFlags.WordBreak);
                    errBoxH = 29 + sz.Height + 14 + 10;
                }
            }
            else errBoxH = 0;
            int rows = State != null ? Math.Max(1, State.Latest.Services.Count) : 1;
            Height = HeaderH + errBoxH + rows * RowH + FooterH;
            refreshLink.Location = new Point(Width - refreshLink.Width - 12, Height - FooterH + 8);
            dashLink.Location = new Point(refreshLink.Left - dashLink.Width - 10, Height - FooterH + 8);
        }

        // 오류별로 "그래서 뭘 하면 되는지" 안내 (테스트에서 매칭 검증하므로 internal)
        internal static string GuideFor(string error)
        {
            if (error == null) return "";
            if (error.StartsWith("네트워크")) return "인터넷 연결을 확인하세요. 연결이 돌아오면 자동으로 복구됩니다.";
            if (error.StartsWith("데이터 조회 실패")) return "GitHub 일시 오류일 수 있습니다. 5분마다 자동 재시도하니 잠시 기다려보세요.";
            if (error.StartsWith("점검 이력 지연")) return "경량 모니터링 발사(Apps Script/GitHub 크론)가 지연되고 있을 수 있습니다. 계속되면 ds-light-monitor 레포의 Actions 실행 이력을 확인하세요.";
            if (error.StartsWith("점검 이력이 비어")) return "데이터 파일이 초기화됐을 수 있습니다. 다음 경량 점검(최대 30분) 후 자동으로 채워집니다.";
            return "5분마다 자동으로 다시 시도합니다.";
        }

        static string FmtChecked(DateTimeOffset dt)
        {
            var local = dt.ToLocalTime();
            int mins = (int)(DateTimeOffset.Now - dt).TotalMinutes;
            string ago = mins < 1 ? "방금" : mins < 60 ? mins + "분 전" : (mins / 60) + "시간 " + (mins % 60) + "분 전";
            return local.ToString("HH:mm") + " 점검 (" + ago + ")";
        }

        static Color StatusColor(ServiceStat s)
        {
            if (!s.Ok) return Color.FromArgb(235, 87, 87);
            if (s.Slow || s.ImgBroken) return Color.FromArgb(242, 153, 74);
            return Color.FromArgb(111, 207, 151);
        }

        static string StatusWord(ServiceStat s)
        {
            if (!s.Ok) return "장애";
            if (s.ImgBroken) return "이미지 깨짐";
            if (s.Slow) return "느림";
            return "정상";
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            using (var pen = new Pen(Color.FromArgb(60, 62, 66)))
                g.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);

            using (var titleFont = new Font("맑은 고딕", 10.5f, FontStyle.Bold))
            using (var titleBrush = new SolidBrush(Color.FromArgb(240, 240, 240)))
                g.DrawString("DS 서비스 상태", titleFont, titleBrush, 14, 13);

            using (var chipFont = new Font("맑은 고딕", 8f, FontStyle.Bold))
            using (var labelFont = new Font("맑은 고딕", 9f))
            using (var statusFont = new Font("맑은 고딕", 9.5f, FontStyle.Bold))
            using (var smallFont = new Font("맑은 고딕", 7.5f))
            using (var labelBrush = new SolidBrush(Color.FromArgb(205, 205, 210)))
            using (var dimBrush = new SolidBrush(Color.FromArgb(135, 137, 143)))
            using (var trackBrush = new SolidBrush(Color.FromArgb(52, 54, 59)))
            {
                // 점검 주기 칩
                {
                    string chipTxt = "경량 · 30분 주기";
                    var sz = g.MeasureString(chipTxt, chipFont);
                    var chip = new Rectangle(Width - 14 - (int)sz.Width - 12, 13, (int)sz.Width + 12, 20);
                    using (var cb = new SolidBrush(Color.FromArgb(52, 54, 59)))
                        FillRounded(g, cb, chip, 9);
                    g.DrawString(chipTxt, chipFont, labelBrush, chip.X + 6, chip.Y + 3);
                }

                int y = HeaderH;

                if (Error != null)
                {
                    int ebh = Math.Max(errBoxH, 56);
                    var box = new Rectangle(12, y, Width - 24, ebh - 10);
                    using (var eb = new SolidBrush(Color.FromArgb(52, 34, 36)))
                        FillRounded(g, eb, box, 6);
                    using (var ebPen = new Pen(Color.FromArgb(130, 235, 87, 87)))
                        DrawRounded(g, ebPen, box, 6);
                    using (var errFont = new Font("맑은 고딕", 8.5f, FontStyle.Bold))
                    using (var errBrush = new SolidBrush(Color.FromArgb(245, 130, 130)))
                        g.DrawString("⚠ " + Error, errFont, errBrush, box.X + 8, box.Y + 7);
                    var guideRect = new RectangleF(box.X + 9, box.Y + 27, box.Width - 18, box.Height - 31);
                    g.DrawString(GuideFor(Error), smallFont, labelBrush, guideRect);
                    y += ebh;
                }

                if (State != null)
                {
                    foreach (var svc in State.Latest.Services)
                    {
                        g.DrawString(svc.Name, labelFont, labelBrush, 14, y + 4);

                        string word = StatusWord(svc);
                        var wordSize = g.MeasureString(word, statusFont);
                        using (var sb = new SolidBrush(StatusColor(svc)))
                            g.DrawString(word, statusFont, sb, Width - 14 - wordSize.Width, y + 3);

                        // 24시간 가동률 바
                        double up;
                        State.Uptime24h.TryGetValue(svc.Key, out up);
                        int barY = y + 28;
                        int barW = Width - 28;
                        var track = new Rectangle(14, barY, barW, 7);
                        FillRounded(g, trackBrush, track, 3);
                        if (up >= 0)
                        {
                            int fillW = (int)(barW * Math.Min(100.0, up) / 100.0);
                            if (fillW > 5)
                            {
                                Color upColor = up >= 99 ? Color.FromArgb(111, 207, 151) : up >= 95 ? Color.FromArgb(242, 153, 74) : Color.FromArgb(235, 87, 87);
                                using (var fb2 = new SolidBrush(upColor))
                                    FillRounded(g, fb2, new Rectangle(14, barY, fillW, 7), 3);
                            }
                        }

                        string info = (svc.Ok ? "응답 " + (svc.Elapsed / 1000.0).ToString("0.0") + "초" : "접속 실패")
                            + (up >= 0 ? " · 24h 가동률 " + up.ToString("0.#") + "%" : "");
                        g.DrawString(info, smallFont, dimBrush, 13, barY + 13);
                        y += RowH;
                    }
                }

                string footer = State == null && Error == null
                    ? "불러오는 중..."
                    : (State != null ? FmtChecked(State.Latest.Ts) : "5분 자동 갱신");
                g.DrawString(footer, smallFont, dimBrush, 13, Height - FooterH + 10);
            }
        }

        static GraphicsPath RoundedPath(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            int d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        static void FillRounded(Graphics g, Brush b, Rectangle r, int radius)
        {
            using (var path = RoundedPath(r, radius)) g.FillPath(b, path);
        }

        static void DrawRounded(Graphics g, Pen p, Rectangle r, int radius)
        {
            using (var path = RoundedPath(r, radius)) g.DrawPath(p, path);
        }
    }
}
