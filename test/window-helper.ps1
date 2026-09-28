# Test helper, Windows only, started by test/run.ts next to the isolated VS Code
# it launches. It does two jobs, and touches only top-level windows of the
# process ID passed in (the isolated instance's main process), found with Win32
# EnumWindows, so it cannot reach the user's own VS Code or anything else:
#
# 1. Keeps the test window out of the user's way. -Hide minimize shows it
#    minimized without activating it (ShowWindow SW_SHOWMINNOACTIVE);
#    -Hide offscreen moves it to -32000,-32000 without activating it
#    (SetWindowPos SWP_NOACTIVATE), which keeps it rendered. Either is
#    re-applied if VS Code restores the window. It never activates a window.
# 2. Answers the confirmation dialogs that tokenless tool calls raise. With
#    the default window.dialogStyle ("native") these are OS task dialogs
#    (Electron dialog.showMessageBox, class #32770). It reads the button names
#    with UI Automation, which shows them as Panes without an Invoke pattern,
#    so it presses the first one that is not Cancel/No with the dialog's own
#    TDM_CLICK_BUTTON message; that needs no focus. Electron ignores clicks for
#    button IDs it did not create, so a wrong guess does nothing. Each press is
#    logged.
#
# It stops when that process exits.
#
# With -InvokeButton <name> it instead does one thing and exits: presses the
# workbench button with that accessible name (for example the integrated
# browser toolbar's "Share with Agent") through UI Automation's Invoke or,
# for a toggle button like that one, Toggle pattern, in the same process's
# windows. That is the button a user clicks, so
# the test shares a page the way a user does. It prints what it pressed.

param(
	[Parameter(Mandatory)] [int] $ProcessId,
	[Parameter(Mandatory)] [string] $LogFile,
	[ValidateSet('minimize', 'offscreen', 'none')] [string] $Hide = 'offscreen',
	# Leave dialogs for a person to answer.
	[switch] $NoClick,
	[string] $InvokeButton
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Bridge -Name Win32 -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr hwnd, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hwnd, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetClassName(System.IntPtr hwnd, System.Text.StringBuilder name, int max);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hwnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr hwnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hwnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hwnd, int cmd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hwnd, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hwnd, out RECT rect);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr hwnd, uint msg, System.IntPtr w, System.IntPtr l);
public struct RECT { public int Left, Top, Right, Bottom; }
public static System.Collections.Generic.List<System.IntPtr> Windows(uint processId, string className) {
	var found = new System.Collections.Generic.List<System.IntPtr>();
	EnumWindows((h, l) => {
		uint pid; GetWindowThreadProcessId(h, out pid);
		if (pid != processId || !IsWindowVisible(h)) return true;
		var cls = new System.Text.StringBuilder(64); GetClassName(h, cls, 64);
		if (cls.ToString() == className) found.Add(h);
		return true;
	}, System.IntPtr.Zero);
	return found;
}
'@
$W = [Bridge.Win32]
$SW_SHOWMINNOACTIVE = 7
$SWP_NOSIZE_NOZORDER_NOACTIVATE = 0x0001 -bor 0x0004 -bor 0x0010
$TDM_CLICK_BUTTON = 0x0466

$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]::Descendants
$ControlType = [System.Windows.Automation.ControlType]
$isButton = New-Object System.Windows.Automation.OrCondition(
	(New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $ControlType::Button)),
	(New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $ControlType::Pane)))
$isText = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $ControlType::Text)

function Hide-Window([System.IntPtr] $hwnd) {
	if ($Hide -eq 'minimize' -and -not $W::IsIconic($hwnd)) {
		[void]$W::ShowWindow($hwnd, $SW_SHOWMINNOACTIVE)
		Add-Content -Path $LogFile -Value ("{0:HH:mm:ss.fff} window {1} minimized without activation" -f (Get-Date), $hwnd)
	} elseif ($Hide -eq 'offscreen') {
		$rect = New-Object Bridge.Win32+RECT
		[void]$W::GetWindowRect($hwnd, [ref] $rect)
		if ($rect.Left -gt -30000) {
			[void]$W::SetWindowPos($hwnd, [System.IntPtr]::Zero, -32000, -32000, 0, 0, $SWP_NOSIZE_NOZORDER_NOACTIVATE)
			Add-Content -Path $LogFile -Value ("{0:HH:mm:ss.fff} window {1} moved off-screen without activation" -f (Get-Date), $hwnd)
		}
	}
}

function Answer-Dialog([System.IntPtr] $hwnd) {
	$dialog = $A::FromHandle($hwnd)
	$texts = $dialog.FindAll($Scope, $isText) | ForEach-Object { $_.Current.Name } | Where-Object { $_ }
	$names = @($dialog.FindAll($Scope, $isButton) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
	$index = [array]::FindIndex($names, [Predicate[string]] { param($n) $n -notmatch '^&?(Cancel|No|Close|Deny)$' })
	if ($index -lt 0) {
		return
	}
	# Electron numbers custom buttons 100, 101, ... in order; "Yes" and "OK"
	# may instead be the common IDYES (6) and IDOK (1).
	$how = 'not pressed'
	foreach ($id in @((100 + $index), 6, 1)) {
		[void]$W::SendMessage($hwnd, $TDM_CLICK_BUTTON, [System.IntPtr]$id, [System.IntPtr]::Zero)
		Start-Sleep -Milliseconds 200
		if (-not $W::IsWindow($hwnd)) {
			$how = "TDM_CLICK_BUTTON id=$id"
			break
		}
	}
	Add-Content -Path $LogFile -Value ("{0:HH:mm:ss.fff} dialog class=#32770 text='{1}' button='{2}' ({3})" -f (Get-Date), ($texts -join ' | '), $names[$index], $how)
}

if ($InvokeButton) {
	$byName = New-Object System.Windows.Automation.AndCondition(
		(New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $ControlType::Button)),
		(New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $InvokeButton)))
	# Chromium builds its accessibility tree once a UI Automation client asks,
	# so the first searches can come back empty.
	for ($try = 0; $try -lt 40; $try++) {
		foreach ($hwnd in $W::Windows([uint32]$ProcessId, 'Chrome_WidgetWin_1')) {
			$button = $A::FromHandle($hwnd).FindFirst($Scope, $byName)
			if ($button) {
				# A toggle button (such as Share with Agent) offers Toggle instead of Invoke.
				$pattern = $null
				if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref] $pattern)) {
					$pattern.Invoke()
				} elseif ($button.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref] $pattern)) {
					$pattern.Toggle()
				} else {
					"'$InvokeButton' supports neither Invoke nor Toggle"
					exit 1
				}
				"pressed '$InvokeButton' in window $hwnd of process $ProcessId"
				exit 0
			}
		}
		Start-Sleep -Milliseconds 250
	}
	"no button named '$InvokeButton' in process $ProcessId"
	exit 1
}

while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
	if ($Hide -ne 'none') {
		foreach ($hwnd in $W::Windows([uint32]$ProcessId, 'Chrome_WidgetWin_1')) {
			Hide-Window $hwnd
		}
	}
	foreach ($hwnd in $(if ($NoClick) { @() } else { $W::Windows([uint32]$ProcessId, '#32770') })) {
		try {
			Answer-Dialog $hwnd
		} catch {
			# Usually the dialog closed while being read; the next pass sees the new state.
			Add-Content -Path $LogFile -Value ("{0:HH:mm:ss.fff} dialog read failed: {1}" -f (Get-Date), $_.Exception.Message)
		}
	}
	Start-Sleep -Milliseconds 100
}
