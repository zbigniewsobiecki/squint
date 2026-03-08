module RubySimple
  module Utils
    def self.format_name(name)
      name.strip.capitalize
    end

    def self.greet(name)
      "Hello, #{format_name(name)}!"
    end
  end
end