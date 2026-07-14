import {
  Bug,
  CalendarClock,
  Image,
  LayoutDashboard,
  MessageSquare,
  Settings,
  Sparkles,
  Users,
  UsersRound,
  VenetianMask,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Planned-but-not-built routes render disabled with a "soon" hint. */
  soon?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/**
 * Single source of truth for dashboard navigation. Feature pages register here
 * as they land; `soon` marks planned v1 routes so the shell shows intended shape
 * without dead links.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Main",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/history", label: "History", icon: MessageSquare },
      { href: "/scheduled-tasks", label: "Scheduled tasks", icon: CalendarClock },
      { href: "/vision", label: "Vision", icon: Image },
      { href: "/self-improvement", label: "Self-improvement", icon: Sparkles },
      { href: "/users", label: "Users", icon: Users },
      { href: "/groups", label: "Groups", icon: UsersRound },
      { href: "/debug", label: "Debug", icon: Bug },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/personalities", label: "Personalities", icon: VenetianMask },
      { href: "/tools", label: "Tools", icon: Wrench },
    ],
  },
];
