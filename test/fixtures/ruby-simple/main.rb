require_relative 'version'
require_relative 'user_service'

puts "Starting RubySimple v#{RubySimple::VERSION}"

service = RubySimple::UserService.new(name: " world ")
service.perform