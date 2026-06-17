class KiroTimelog < Formula
  desc "Automatic time tracking for Kiro CLI sessions"
  homepage "https://github.com/bachvh/kiro-timelog"
  url "https://registry.npmjs.org/kiro-timelog/-/kiro-timelog-1.0.0.tgz"
  sha256 "PLACEHOLDER"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def post_install
    system bin/"kirolog", "--help" rescue nil
  end

  def caveats
    <<~EOS
      To enable automatic scanning every 5 minutes:
        kirolog install-scheduler

      To create a config file:
        mkdir -p ~/.kiro/timelog
        echo '{"projectPattern": "YOUR_PROJECTS_DIR/([^/]+)"}' > ~/.kiro/timelog/config.json

      Usage:
        kirolog              # this week's report
        kirolog --month      # this month
        kirolog --timesheet  # project × ticket summary
    EOS
  end

  test do
    assert_match "No data", shell_output("#{bin}/kirolog --week 2>&1", 0)
  end
end
