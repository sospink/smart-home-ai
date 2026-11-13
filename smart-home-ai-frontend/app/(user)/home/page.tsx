"use client";


import DynamicLighting from "@/components/home/DynamicLighting";
import HeroSection from "@/components/home/HeroSection";
import RuntimeStatusSection from "@/components/home/RuntimeStatusSection";
import CapabilitiesSection from "@/components/home/CapabilitiesSection";
import ScenariosSection from "@/components/home/ScenariosSection";
import TechnologySection from "@/components/home/TechnologySection";
import CTASection from "@/components/home/CTASection";
import Footer from "@/components/home/Footer";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background relative">
      {/* Noise texture overlay for atmospheric film grain */}
      <div className="noise-overlay" />

      {/* Dynamic warm→cool lighting that responds to scroll */}
      <DynamicLighting />

      {/* Content */}
      <div className="relative z-10">

        <HeroSection />
        <RuntimeStatusSection />
        <CapabilitiesSection />
        <ScenariosSection />
        <TechnologySection />
        <CTASection />
        <Footer />
      </div>
    </div>
  );
}
