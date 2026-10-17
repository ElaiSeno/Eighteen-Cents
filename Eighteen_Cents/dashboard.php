<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Eighteen Cents - Piggy Bank</title>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap">

<link rel="stylesheet" href="Assets/CSS/background.css">
<link rel="stylesheet" href="Assets/CSS/dashboard.css">
</head>
<body>

<div class="wrapper">
<div class="app">

    <!-- NAVIGATION (bottom bar on mobile, sidebar on desktop) -->
    <nav class="nav" aria-label="Main">
        <div class="brand">Eighteen Cents</div>
        <button data-t="home" class="on"></button>
        <button data-t="charts"></button>
        <button data-t="goals"></button>
        <button data-t="me"></button>
    </nav>

    <main class="main">

        <!-- HOME -->
        <section id="home" class="tab on">
            <div class="top">
                <div>
                    <h1 id="hi">Hello 👋</h1>
                    <p class="sub">Here's how your piggy bank is doing.</p>
                </div>
                <select id="month" class="sel" aria-label="Choose month"></select>
            </div>

            <div class="stats">
                <div class="card stat bal"><span>Balance this month</span><b id="sBal">-</b></div>
                <div class="card stat"><span>Income</span><b class="in" id="sInc">-</b></div>
                <div class="card stat"><span>Expenses</span><b class="out" id="sExp">-</b></div>
            </div>

            <div id="wdBanner"></div>

            <div class="card" id="budgetCard"></div>

            <div class="card gap">
                <h2>Transactions</h2>
                <div class="chips">
                    <button class="chip on" data-f="all">All</button>
                    <button class="chip" data-f="income">Income</button>
                    <button class="chip" data-f="expense">Expenses</button>
                    <input class="search" id="q" placeholder="Search notes…" aria-label="Search transactions">
                </div>
                <div id="list"></div>
            </div>
        </section>

        <!-- CHARTS -->
        <section id="charts" class="tab">
            <div class="top">
                <div><h1>Charts</h1><p class="sub" id="cSub"></p></div>
            </div>
            <div class="grid two">
                <div class="card"><h2>Where your money went</h2><div id="donut"></div></div>
                <div class="card"><h2>Daily spending</h2><div id="daily"></div></div>
                <div class="card wide"><h2>Income vs expenses</h2><p class="sub">Last 5 months</p><div id="trend"></div></div>
            </div>
        </section>

        <!-- BUDGET & GOALS -->
        <section id="goals" class="tab">
            <div class="top">
                <div><h1>Budget &amp; goals</h1><p class="sub">Plan ahead and watch your savings grow.</p></div>
            </div>
            <div class="grid two">
                <div class="card" id="budgetBig"></div>
                <div class="card">
                    <div class="top nomb"><h2>Savings goals</h2><button class="btn o" id="newGoal">+ New goal</button></div>
                    <div id="goalList"></div>
                </div>
            </div>
        </section>

        <!-- PROFILE -->
        <section id="me" class="tab">
            <div class="top">
                <div><h1>Profile</h1><p class="sub">Your account and preferences.</p></div>
            </div>
            <div class="grid two">
                <div class="card">
                    <div class="who">
                        <div class="av" id="av"></div>
                        <div><h2 id="nm"></h2><p class="sub" id="em"></p></div>
                    </div>
                    <div id="prefs"></div>
                    <a class="btn out-btn" href="Login.php">Log out</a>
                </div>
                <div class="card"><h2>Notifications</h2><div id="notes"></div></div>
                <div class="card wide">
                    <div class="top nomb"><h2>Withdrawal history</h2><span class="count" id="pc">0</span></div>
                    <div class="chips">
                        <button class="chip on" data-wf="all">All</button>
                        <button class="chip" data-wf="approved">Approved</button>
                        <button class="chip" data-wf="rejected">Rejected</button>
                        <button class="chip" data-wf="expired">Expired</button>
                    </div>
                    <div id="wList"></div>
                    <button class="btn o" id="simBtn" hidden>Simulate incoming withdrawal (preview)</button>
                </div>
            </div>
        </section>

    </main>
</div>
</div>



<dialog id="dlg">
    <div class="dh"><h2 id="dT"></h2><button class="x" id="dX" aria-label="Close">✕</button></div>
    <div id="dB"></div>
</dialog>

<!-- WITHDRAWAL APPROVAL SHEET -->
<dialog id="wdlg" aria-labelledby="wtitle"><div class="sheet" id="wsheet"></div></dialog>

<div class="toast" id="toast" role="status"></div>

<script src="Assets/Js/background-load.js"></script>
<script src="Assets/Js/dashboard1.js"></script>
</body>
</html>
