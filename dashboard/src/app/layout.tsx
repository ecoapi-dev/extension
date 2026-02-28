import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar";

export default function Layout() {
  return (
    <div className="flex h-screen bg-[#0B0F0B] text-[#D6EDD0] font-mono overflow-hidden">
      <Sidebar />
      <div className="flex-1 ml-[56px] overflow-auto">
        <div className="p-6 max-w-7xl mx-auto min-h-full">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
