require_relative 'base_service'
require_relative 'utils'

module RubySimple
  class UserService < BaseService
    def perform
      name = options[:name]
      greeting = Utils.greet(name)
      puts greeting
      greeting
    end
  end
end