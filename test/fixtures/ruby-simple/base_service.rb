module RubySimple
  class BaseService
    attr_reader :options

    def initialize(options = {})
      @options = options
    end

    def perform
      raise NotImplementedError, "#{self.class} must implement #perform"
    end
  end
end