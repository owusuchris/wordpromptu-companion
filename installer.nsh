!macro customInit
  ; The companion is a tray app — closing its window never quits the process
  ; (see main.js window-all-closed), so a prior version left running in the
  ; tray holds its .exe locked and the stock upgrade step can't replace it,
  ; surfacing NSIS's "cannot be closed, click Retry" dialog. Force-close any
  ; running instance up front so upgrades never hit that prompt. Harmless
  ; no-op on a fresh install (taskkill just fails to find the process).
  nsExec::Exec 'taskkill /F /IM "Wordpromptu Companion.exe" /T'
  Pop $0
!macroend
