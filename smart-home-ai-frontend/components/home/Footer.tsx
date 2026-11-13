import { Home } from "lucide-react";

const Footer = () => {
  return (
    <footer className="py-12 border-t border-border/50">
      <div className="max-w-7xl mx-auto section-padding flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-primary/10 flex items-center justify-center">
            <Home className="w-3 h-3 text-primary" />
          </div>
          <span className="font-display font-semibold text-sm text-foreground">基于智慧家居场景的大语言模型智能体科研应用平台</span>
        </div>
        <p className="text-sm text-muted-foreground">
          © 2026 智能体科研平台. 开源科研项目。
        </p>
      </div>
    </footer>
  );
};

export default Footer;
